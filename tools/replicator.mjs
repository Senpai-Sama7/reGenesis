#!/usr/bin/env node
/**
 * Website Replicator + Verifier + Brand Generator bridge
 * ESM, Node 20+
 */
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import os from "node:os";
import zlib from "node:zlib";

import puppeteer from "puppeteer";
import puppeteerExtra from "puppeteer-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import * as cheerio from "cheerio";
import sharp from "sharp";
import PQueue from "p-queue";
import { optimize as optimizeSvg } from "svgo";
import pino from "pino";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import robotsParser from "robots-parser";

if (!globalThis.fetch) {
  const { fetch, Request, Response, Headers } = await import("undici");
  globalThis.fetch = fetch; globalThis.Request = Request; globalThis.Response = Response; globalThis.Headers = Headers;
}

puppeteerExtra.use(stealth());
const logger = pino({ transport: { target: 'pino-pretty' } });

class CSSProcessor {
  rewriteUrls(cssContent, urlRewriter) {
    const urlPattern = /url\s*\(\s*(['"]?)([^'")]+?)\1\s*\)/gi;
    return cssContent.replace(urlPattern, (match, quote, originalUrl) => {
      if (!originalUrl || originalUrl.startsWith('data:')) return match;
      const rewrittenUrl = urlRewriter(originalUrl);
      return `url(${quote}${rewrittenUrl}${quote})`;
    });
  }
  minify(cssContent) {
    return cssContent
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .replace(/;\s*}/g, '}')
      .replace(/,\s+/g, ',')
      .replace(/:\s+/g, ':')
      .trim();
  }
}

class HTMLProcessor {
  constructor(){
    this.urlAttributes = new Map([
      ['img', ['src', 'srcset']], ['source', ['src', 'srcset']],
      ['link', ['href']], ['script', ['src']],
      ['video', ['src', 'poster']], ['audio', ['src']],
      ['iframe', ['src']], ['form', ['action']],
    ]);
  }
  processSrcset(srcsetValue, urlRewriter) {
    if (!srcsetValue) return '';
    return srcsetValue.split(',').map(part => {
      const [url, descriptor] = part.trim().split(/\s+/);
      return `${urlRewriter(url)} ${descriptor || ''}`.trim();
    }).join(', ');
  }
  rewriteUrls(htmlContent, urlRewriter, cssProcessor) {
    const $ = cheerio.load(htmlContent, { decodeEntities: false });
    this.urlAttributes.forEach((attrs, tag) => {
      $(tag).each((_, el) => {
        const $el = $(el);
        for (const attr of attrs){
          const val = $el.attr(attr);
          if (!val) continue;
          if (attr.includes('srcset')) $el.attr(attr, this.processSrcset(val, urlRewriter));
          else $el.attr(attr, urlRewriter(val));
        }
      });
    });
    $('[style]').each((_, el) => {
      const $el = $(el);
      const style = $el.attr('style') || '';
      $el.attr('style', cssProcessor.rewriteUrls(style, urlRewriter));
    });
    $('style').each((_, el) => {
      const $el = $(el);
      const css = $el.html() || '';
      $el.html(cssProcessor.rewriteUrls(css, urlRewriter));
    });
    return $.html();
  }
}

class AdvancedCircuitBreaker extends EventEmitter {
  constructor(opts = {}){
    super();
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.successThreshold = opts.successThreshold ?? 3;
    this.timeout = opts.timeout ?? 30000;
    this.retryTimeoutBase = opts.retryTimeoutBase ?? 1000;
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttempt = Date.now();
  }
  async execute(operation){
    if (this.state === 'OPEN'){
      if (Date.now() < this.nextAttempt) throw new Error('Circuit breaker is OPEN.');
      this.state = 'HALF_OPEN'; this.successCount = 0;
    }
    try{
      const result = await Promise.race([
        operation(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Operation timed out.')), this.timeout))
      ]);
      this.onSuccess(); return result;
    } catch (e){
      this.onFailure(); throw e;
    }
  }
  onSuccess(){
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN'){
      this.successCount++;
      if (this.successCount >= this.successThreshold){ this.state = 'CLOSED'; this.emit('close'); }
    } else { this.state = 'CLOSED'; }
    this.emit('success');
  }
  onFailure(){
    this.failureCount++;
    if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold){
      this.state = 'OPEN';
      const exponent = this.failureCount - this.failureThreshold;
      const wait = this.retryTimeoutBase * Math.pow(2, Math.max(0, exponent));
      this.nextAttempt = Date.now() + wait;
      this.emit('open');
    }
    this.emit('failure');
  }
}

export class UltimateWebsiteReplicator extends EventEmitter {
  constructor(options = {}){
    super();
    this.options = Object.assign({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      timeout: 60000,
      pageConcurrency: 4,
      baseAssetConcurrency: 10,
      domainAssetConcurrency: 3,
      maxRetries: 3,
      retryDelayBase: 1000,
      incremental: false,
      crawlSPA: true,
      maxCrawlDepth: 2,
      respectRobotsTxt: true,
      optimizeImages: true,
      enableAVIF: true,
      minifyCSS: true,
      captureResponsive: false,
      responsiveBreakpoints: [{ name: 'mobile', width: 375, height: 812 }, { name: 'desktop', width: 1920, height: 1080 }],
      enableBrotli: false,
      memoryThreshold: 0.85,
    }, options);

    this.pageQueue = new PQueue({ concurrency: this.options.pageConcurrency });
    this.cssProcessor = new CSSProcessor();
    this.htmlProcessor = new HTMLProcessor();

    this.state = {
      browser: null,
      manifest: { assets: {} },
      urlToLocalPath: new Map(),
      crawledUrls: new Set(),
      failedUrls: new Set(),
      pendingAssets: new Set(),
      robots: null,
      baseUrl: '',
      outputDir: '',
      memoryMonitor: null,
      domainQueues: new Map(),
      circuitBreakers: new Map(),
    };
    this.stats = { totalAssets: 0, totalSize: 0, crawledPages: 0, skippedAssets: 0, failedAssets: 0 };
    ['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => this.shutdown()));
  }

  async initialize(){
    logger.info('Initializing browser...');
    this.state.browser = await puppeteerExtra.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    logger.info('Browser initialized.');
  }

  startMemoryMonitor(){
    this.state.memoryMonitor = setInterval(() => {
      const usage = process.memoryUsage().heapUsed / os.totalmem();
      if (usage > this.options.memoryThreshold){
        logger.warn({ usage }, 'Memory threshold exceeded.');
        if (global.gc){ logger.info('Forcing GC.'); global.gc(); }
      }
    }, 15000);
  }

  async shutdown(){
    logger.info('Shutting down...');
    if (this.state.memoryMonitor) clearInterval(this.state.memoryMonitor);
    this.pageQueue.clear();
    Array.from(this.state.domainQueues.values()).forEach(q => q.clear());
    if (this.state.browser) await this.state.browser.close();
    logger.info('Shutdown complete.');
  }

  async replicate(targetUrl, outputDir){
    const start = Date.now();
    this.state.baseUrl = new URL(targetUrl).origin;
    this.state.outputDir = path.resolve(outputDir);
    await fs.mkdir(this.state.outputDir, { recursive: true });
    logger.info({ options: this.options }, 'Replication starting');

    try{
      if (this.options.incremental) await this.loadManifest();
      await this.initialize();
      this.startMemoryMonitor();
      const initialUrls = await this.discoverInitialUrls(targetUrl);
      logger.info({ count: initialUrls.size }, 'Initial URLs');

      for (const url of initialUrls){
        if (!this.state.crawledUrls.has(url)){
          this.state.crawledUrls.add(url);
          this.pageQueue.add(() => this.processPage(url, 0));
        }
      }

      await this.pageQueue.onIdle();
      await Promise.all(Array.from(this.state.domainQueues.values()).map(q => q.onIdle()));
      await this.generateManifest();
      const duration = (Date.now() - start) / 1000;
      logger.info({ duration: `${duration.toFixed(2)}s`, stats: this.stats }, 'Replication complete');
      this.emit('complete', { duration, stats: this.stats });
    } catch (e){
      logger.fatal(e, 'Fatal during replication');
      throw e;
    } finally {
      await this.shutdown();
    }
  }

  async discoverInitialUrls(entryUrl){
    const urls = new Set([entryUrl]);
    try{
      const robotsUrl = new URL('/robots.txt', this.state.baseUrl).href;
      const res = await fetch(robotsUrl);
      if (res.ok){
        const txt = await res.text();
        this.state.robots = robotsParser(robotsUrl, txt);
        const sitemaps = this.state.robots.getSitemaps();
        for (const sm of sitemaps){ await this.parseSitemap(sm, urls); }
      }
    } catch (e){ logger.warn({ e: e.message }, 'robots.txt unavailable'); }
    try{ await this.parseSitemap(new URL('/sitemap.xml', this.state.baseUrl).href, urls); }
    catch(e){ logger.warn('No default sitemap.xml'); }
    return urls;
  }

  async parseSitemap(sitemapUrl, urlSet){
    try{
      const res = await fetch(sitemapUrl);
      if (!res.ok) return;
      const xml = await res.text();
      const $ = cheerio.load(xml, { xmlMode: true });
      $('loc').each((_, el) => {
        const u = $(el).text();
        if (u.startsWith(this.state.baseUrl)) urlSet.add(u);
      });
      logger.info({ url: sitemapUrl, count: urlSet.size }, 'Parsed sitemap');
    } catch (e){
      logger.error({ e: e.message, url: sitemapUrl }, 'Failed to parse sitemap');
    }
  }

  async processPage(pageUrl, depth){
    if (depth > this.options.maxCrawlDepth) return;
    if (this.state.robots && !this.state.robots.isAllowed(pageUrl, this.options.userAgent)){
      logger.warn({ url: pageUrl }, 'Disallowed by robots.txt'); return;
    }
    logger.info({ url: pageUrl, depth }, 'Processing page');
    const page = await this.state.browser.newPage();
    await page.setViewport(this.options.viewport);
    await page.setUserAgent(this.options.userAgent);
    try{
      const pageAssetInfo = this.state.manifest.assets[this.getLocalPathForUrl(pageUrl)];
      const headers = {};
      if (this.options.incremental && pageAssetInfo?.etag) headers['If-None-Match'] = pageAssetInfo.etag;
      if (this.options.incremental && pageAssetInfo?.lastModified) headers['If-Modified-Since'] = pageAssetInfo.lastModified;
      await page.setExtraHTTPHeaders(headers);
      const res = await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: this.options.timeout });
      if (res.status() === 304){
        logger.info({ url: pageUrl }, 'Not modified (304)'); this.stats.skippedAssets++; await page.close(); return;
      }
      const discovered = new Set();
      page.on('response', r => {
        const u = r.url();
        if (r.ok() && !u.startsWith('data:')) discovered.add(u);
      });
      await page.waitForTimeout(1000);
      let html = await page.content();
      const etag = res.headers().etag;
      const lastModified = res.headers()['last-modified'];

      for (const assetUrl of discovered){
        const localPath = this.getLocalPathForUrl(assetUrl);
        this.state.urlToLocalPath.set(assetUrl, localPath);
        this.captureAsset(assetUrl);
      }

      const rewritten = this.htmlProcessor.rewriteUrls(html, (u) => this.rewriteUrl(u, pageUrl), this.cssProcessor);
      const localPath = this.getLocalPathForUrl(pageUrl);
      const full = path.join(this.state.outputDir, localPath);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, rewritten);
      const hash = crypto.createHash('sha256').update(rewritten).digest('hex');
      this.state.urlToLocalPath.set(pageUrl, localPath);
      this.state.manifest.assets[localPath] = { originalUrl: pageUrl, contentType: 'text/html', size: rewritten.length, integrity: `sha256-${hash}`, etag, lastModified };
      this.stats.crawledPages++;

      if (this.options.captureResponsive){
        for (const bp of this.options.responsiveBreakpoints){ await this.captureScreenshot(page, pageUrl, bp); }
      }
      if (this.options.crawlSPA && depth < this.options.maxCrawlDepth){
        const links = this.discoverLinks(html, pageUrl);
        for (const link of links){
          if (!this.state.crawledUrls.has(link)){ this.state.crawledUrls.add(link); this.pageQueue.add(() => this.processPage(link, depth + 1)); }
        }
      }
    } catch (e){
      logger.error({ url: pageUrl, err: e.message }, 'Failed to process page');
    } finally {
      await page.close();
    }
  }

  getQueueForDomain(domain){
    if (!this.state.domainQueues.has(domain)){
      const isBase = domain === new URL(this.state.baseUrl).hostname;
      const concurrency = isBase ? this.options.baseAssetConcurrency : this.options.domainAssetConcurrency;
      logger.info({ domain, concurrency }, 'Creating domain queue');
      this.state.domainQueues.set(domain, new PQueue({ concurrency }));
    }
    return this.state.domainQueues.get(domain);
  }
  getCircuitBreakerForDomain(domain){
    if (!this.state.circuitBreakers.has(domain)){
      this.state.circuitBreakers.set(domain, new AdvancedCircuitBreaker({ timeout: this.options.timeout }));
    }
    return this.state.circuitBreakers.get(domain);
  }
  captureAsset(assetUrl){
    const localPath = this.getLocalPathForUrl(assetUrl);
    if (this.state.manifest.assets[localPath] || this.state.failedUrls.has(assetUrl) || this.state.pendingAssets.has(assetUrl)) return;
    this.state.pendingAssets.add(assetUrl);
    const domain = new URL(assetUrl).hostname;
    const q = this.getQueueForDomain(domain);
    const cb = this.getCircuitBreakerForDomain(domain);
    q.add(() => this.fetchAndProcessAsset(assetUrl, cb));
  }
  async fetchAndProcessAsset(assetUrl, circuitBreaker){
    const localPath = this.getLocalPathForUrl(assetUrl);
    if (this.state.manifest.assets[localPath] || this.state.failedUrls.has(assetUrl)){
      this.state.pendingAssets.delete(assetUrl);
      return;
    }
    for (let attempt=0; attempt <= this.options.maxRetries; attempt++){
      try{
        return await circuitBreaker.execute(async () => {
          const headers = {};
          const existing = this.state.manifest.assets[localPath];
          if (this.options.incremental && existing?.etag) headers['If-None-Match'] = existing.etag;
          if (this.options.incremental && existing?.lastModified) headers['If-Modified-Since'] = existing.lastModified;
          const res = await fetch(assetUrl, { headers });
          if (res.status === 304){ logger.info({ url: assetUrl }, 'Asset 304'); this.stats.skippedAssets++; return; }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const contentType = res.headers.get('content-type') || '';
          const isText = /^(text\/|application\/(javascript|json|xml))/.test(contentType);
          const useBrotli = this.options.enableBrotli && isText;
          const localPathBrotli = this.getLocalPathForUrl(assetUrl) + (useBrotli ? '.br' : '');
          const full = path.join(this.state.outputDir, localPathBrotli);
          await fs.mkdir(path.dirname(full), { recursive: true });

          const optimizationStream = this.getOptimizationStream(contentType);
          const compressionStream = useBrotli ? zlib.createBrotliCompress() : null;
          const hash = crypto.createHash('sha256');
          let bytes = 0;
          const hashStream = new Transform({
            transform(chunk, enc, cb){ hash.update(chunk); bytes += chunk.length; cb(null, chunk); }
          });
          const writeStream = fss.createWriteStream(full);

          const streams = [res.body, optimizationStream, compressionStream, hashStream, writeStream].filter(Boolean);
          await pipeline(streams);

          const integrity = `sha256-${hash.digest('hex')}`;
          this.state.urlToLocalPath.set(assetUrl, localPathBrotli);
          this.state.manifest.assets[localPathBrotli] = {
            originalUrl: assetUrl, contentType, size: bytes, integrity,
            etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified')
          };
          this.stats.totalAssets++; this.stats.totalSize += bytes;
          this.state.pendingAssets.delete(assetUrl);
          logger.info({ path: localPathBrotli, size: `${(bytes/1024).toFixed(2)} KB` }, 'Asset captured');
        });
      } catch (e){
        logger.warn({ url: assetUrl, attempt: attempt+1, err: e.message }, 'Asset download failed');
        if (attempt < this.options.maxRetries){
          const delay = (this.options.retryDelayBase * Math.pow(2, attempt)) + (Math.random() * 1000);
          await new Promise(r => setTimeout(r, delay));
        } else {
          logger.error({ url: assetUrl }, 'Asset failed after all retries');
          this.state.failedUrls.add(assetUrl); this.stats.failedAssets++;
          this.state.pendingAssets.delete(assetUrl);
        }
      }
    }
  }

  getOptimizationStream(contentType){
    if (this.options.optimizeImages && contentType.startsWith('image/')){
      if (contentType.includes('svg')){
        return new Transform({
          readableHighWaterMark: 1 << 20,
          writableHighWaterMark: 1 << 20,
          construct(){ this._chunks = []; },
          transform(chunk, _enc, cb){ this._chunks.push(chunk); cb(); },
          flush(cb){ 
            const buf = Buffer.concat(this._chunks);
            try { this.push(Buffer.from(optimizeSvg(buf.toString()).data)); }
            catch(e){ this.push(buf); }
            cb();
          }
        });
      }
      const s = sharp();
      if (this.options.enableAVIF) s.avif({ quality: 75 });
      else s.webp({ quality: 80 });
      return s;
    }
    return new Transform({ transform(chunk, _enc, cb){ cb(null, chunk); } });
  }

  async captureScreenshot(page, pageUrl, bp){
    logger.info({ url: pageUrl, viewport: bp.name }, 'Capturing screenshot');
    const original = page.viewport();
    await page.setViewport(bp);
    await page.waitForTimeout(500);
    const screenshotPath = this.getLocalPathForUrl(pageUrl).replace(/\.html$/, `_${bp.name}.png`);
    const full = path.join(this.state.outputDir, screenshotPath);
    try { await page.screenshot({ path: full, fullPage: true }); logger.info({ path: screenshotPath }, 'Screenshot saved'); }
    catch (e){ logger.error({ err: e.message }, `Failed screenshot for ${bp.name}`); }
    finally { await page.setViewport(original); }
  }

  async loadManifest(){
    const manifestPath = path.join(this.state.outputDir, 'manifest.json');
    try{
      const data = await fs.readFile(manifestPath, 'utf8');
      this.state.manifest = JSON.parse(data);
      for (const [localPath, assetInfo] of Object.entries(this.state.manifest.assets)){
        this.state.urlToLocalPath.set(assetInfo.originalUrl, localPath);
      }
      logger.info(`Loaded manifest with ${Object.keys(this.state.manifest.assets).length} assets`);
    } catch { this.state.manifest = { assets: {} }; }
  }
  async generateManifest(){
    const manifestPath = path.join(this.state.outputDir, 'manifest.json');
    const data = { replicatedAt: new Date().toISOString(), sourceUrl: this.state.baseUrl, stats: this.stats, assets: this.state.manifest.assets };
    await fs.writeFile(manifestPath, JSON.stringify(data, null, 2));
    logger.info(`Wrote ${manifestPath}`);
  }
  async verify(outputDir){
    logger.info({ directory: outputDir }, 'Verifying integrity...');
    const manifestPath = path.join(outputDir, 'manifest.json');
    let manifest;
    try{ manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
    catch{ logger.fatal('manifest.json missing'); return false; }
    let valid = 0, invalid = 0;
    for (const [localPath, assetInfo] of Object.entries(manifest.assets)){
      try{
        const buf = await fs.readFile(path.join(outputDir, localPath));
        const actual = `sha256-${crypto.createHash('sha256').update(buf).digest('hex')}`;
        if (actual === assetInfo.integrity) valid++; else { invalid++; logger.error({ path: localPath }, 'Integrity mismatch'); }
      } catch { invalid++; logger.error({ path: localPath }, 'File missing'); }
    }
    logger.info(`Total: ${Object.keys(manifest.assets).length}, Valid: ${valid}, Invalid: ${invalid}`);
    return invalid === 0;
  }

  discoverLinks(html, baseUrl){
    const $ = cheerio.load(html);
    const links = new Set();
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href'); if (!href) return;
      try{
        const abs = new URL(href, baseUrl).href.split('#')[0];
        if (abs.startsWith(this.state.baseUrl)) links.add(abs);
      } catch {}
    });
    return Array.from(links);
  }
  rewriteUrl(originalUrl, baseUrl){
    if (!originalUrl || originalUrl.startsWith('data:') || originalUrl.startsWith('#')) return originalUrl;
    try{
      const abs = new URL(originalUrl, baseUrl).href;
      if (this.state.urlToLocalPath.has(abs)) return this.state.urlToLocalPath.get(abs);
    } catch {}
    return originalUrl;
  }
  getLocalPathForUrl(assetUrl){
    const u = new URL(assetUrl);
    const pathname = u.pathname.endsWith('/') ? `${u.pathname}index.html` : u.pathname;
    const ext = path.extname(pathname) || '.html';
    const basename = path.basename(pathname, ext);
    const dirname = path.dirname(pathname).substring(1);
    const queryHash = u.search ? `_${crypto.createHash('md5').update(u.search).digest('hex').substring(0, 8)}` : '';
    const safeBasename = basename.replace(/[^a-z0-9_-]/gi, '_');
    const safeDirname = dirname.replace(/[^a-z0-9/_-]/gi, '_');
    return path.join(safeDirname, `${safeBasename}${queryHash}${ext}`);
  }
}

// --- CLI ---
async function main(){
  const argv = yargs(hideBin(process.argv))
    .command('replicate <url> [outputDir]', 'Replicate a website', (y) => {
      y.positional('url', { type: 'string', demandOption: true })
       .positional('outputDir', { type: 'string', default: './replicated-site' })
       .option('depth', { type: 'number', default: 2 })
       .option('incremental', { type: 'boolean', default: false })
       .option('responsive', { type: 'boolean', default: false })
       .option('brotli', { type: 'boolean', default: false })
       .option('pageConcurrency', { type: 'number', default: 4 })
       .option('baseAssetConcurrency', { type: 'number', default: 10 })
       .option('domainAssetConcurrency', { type: 'number', default: 3 });
    }, async (a) => {
      const r = new UltimateWebsiteReplicator({
        maxCrawlDepth: a.depth,
        incremental: a.incremental,
        captureResponsive: a.responsive,
        enableBrotli: a.brotli,
        pageConcurrency: a.pageConcurrency,
        baseAssetConcurrency: a.baseAssetConcurrency,
        domainAssetConcurrency: a.domainAssetConcurrency,
      });
      await r.replicate(a.url, a.outputDir);
    })
    .command('verify <outputDir>', 'Verify integrity of a replica', (y) => {
      y.positional('outputDir', { type: 'string', demandOption: true });
    }, async (a) => {
      const r = new UltimateWebsiteReplicator();
      const ok = await r.verify(a.outputDir);
      process.exit(ok ? 0 : 1);
    })
    .command('generate', 'Generate a brand-driven site (delegates to tools/generate.mjs)', (y) => {
      y.option('brief', { type: 'string', demandOption: true })
       .option('outputDir', { type: 'string', demandOption: true })
       .option('model', { type: 'string', default: 'gemini-2.5-flash-preview-0514' })
       .option('dry-run', { type: 'boolean', default: false })
       .option('force', { type: 'boolean', default: false });
    }, async (a) => {
      const mod = await import(path.resolve('tools/generate.mjs'));
      const brief = JSON.parse(await fs.readFile(path.resolve(a.brief), 'utf8'));
      const html = await mod.synthesizeWebsite(brief, { model: a.model });
      const css = await mod.synthesizeMotion(brief, { model: a.model });
      const out = path.resolve(a.outputDir);
      await fs.mkdir(out, { recursive: true });
      if (!a['dry-run']){
        const i = path.join(out, 'index.html'); const m = path.join(out, 'motion.css');
        if (!a.force && (fss.existsSync(i) || fss.existsSync(m))) { console.error('Output exists. Use --force'); process.exit(1); }
        await fs.writeFile(i, html, 'utf8'); await fs.writeFile(m, css, 'utf8');
        console.log(i); console.log(m);
      } else {
        console.log('[dry-run] bytes', Buffer.byteLength(html,'utf8'), Buffer.byteLength(css,'utf8'));
      }
    })
    .demandCommand(1)
    .strict()
    .help()
    .parse();
}

if (import.meta.url === `file://${process.argv[1]}`){ main().catch(e => { console.error(e); process.exit(1); }); }
