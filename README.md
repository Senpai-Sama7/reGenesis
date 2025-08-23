
-----

# reGenesis 

### The Professional-Grade Website Replication Engine & AI Synthesis Suite

[](https://www.google.com/search?q=%23)
[](https://opensource.org/licenses/MIT)
[](https://www.google.com/search?q=%23)
[](https://www.google.com/search?q=%23)

-----

**reGenesis** is a sophisticated, enterprise-grade Node.js toolkit designed for two primary functions: high-fidelity website replication and AI-driven website generation. It combines a resilient, high-performance crawler with a powerful generative engine to provide a complete solution for web archiving, analysis, and rapid, brand-driven site creation.

-----

### ✨ Key Features

The reGenesis engine is built on a foundation of professional tooling and modern architecture, offering a robust feature set for developers and content managers.

#### 🚀 Core Engine: Replication & Generation

  * **High-Performance Replication**: Utilizes a true streaming pipeline to save assets directly from the network to the disk, minimizing memory usage. Includes on-the-fly image optimization (AVIF/WebP), SVG minification, and optional Brotli compression.
  * **AI-Powered Site Generation**: Leverages Google Gemini to synthesize complete, responsive HTML and CSS from a declarative JSON brand brief. It intelligently maps brand concepts like voice, color, and content intents to production-ready web pages.
  * **Intelligent SPA Crawling**: The replicator can crawl modern Single-Page Applications, automatically discovering new links and respecting a maximum crawl depth to prevent infinite loops.

#### 🛡️ Network Resilience & Control

  * **Per-Domain Concurrency & Circuit Breakers**: Avoids overwhelming servers by limiting concurrent connections per host and isolates failures so a downed CDN won't halt the entire replication process.
  * **Intelligent Retries**: Implements an exponential back-off strategy to gracefully handle transient network errors during asset downloads.
  * **Respectful Crawling**: Includes built-in support for `robots.txt` and `sitemap.xml` to ensure ethical and comprehensive site crawling.

#### 🛠️ Enterprise-Grade Architecture & DX

  * **Scalable Monorepo**: Organized as a monorepo with a clear separation of concerns. This includes dedicated packages for UI components, design tokens, motion, and scrolling logic, enabling maximum code reuse and maintainability.
  * **Standards-Based Design System**: The entire frontend is driven by a W3C DTCG-compliant design and motion token pipeline, which compiles JSON tokens into CSS custom properties and TypeScript constants.
  * **Professional CLI**: A comprehensive command-line interface powered by `yargs` provides three core commands: `replicate`, `generate`, and `verify`.

#### 🔄 Integrity & Auditing

  * **Incremental Replication**: Supports `--incremental` updates by using `ETag` and `Last-Modified` headers to download only the assets that have changed since the last replication.
  * **Integrity Manifest**: Generates a `manifest.json` file with SHA-256 hashes for every asset, allowing for a complete and verifiable archive.
  * **`verify` Command**: A built-in command to re-validate the integrity of a replicated site against its manifest file.

-----

### 🏗️ System Architecture

reGenesis is structured as a professional monorepo to ensure a clean separation of concerns and promote code reuse.

| Path | Description |
| :--- | :--- |
| **`apps/site-example`** | A Next.js application that serves as a demonstration and testing ground for all the packages. |
| **`packages/design-tokens`**| Manages the W3C-compliant design tokens for colors, typography, spacing, etc. |
| **`packages/motion-tokens`**| Manages the W3C-compliant motion tokens for durations, easings, and animations. |
| **`packages/ui`** | A library of headless, accessible React components (e.g., Button, Section) wired to the design tokens. |
| **`packages/motion`** | A collection of helpers for Framer Motion and GSAP that respect `prefers-reduced-motion`. |
| **`packages/scroll`** | Provides smooth scrolling functionality using Lenis, integrated with GSAP ScrollTrigger. |
| **`tools/`** | Contains the core CLI scripts for the `replicate` and `generate` commands. |

-----

### 📦 Installation

#### Prerequisites

  * Node.js **v20.0.0** or higher
  * `pnpm` package manager (recommended)

<!-- end list -->

```bash
# Clone the repository
git clone https://github.com/your-username/reGenesis.git
cd reGenesis

# Install dependencies
pnpm install
```

-----

### 🚀 Usage

reGenesis is operated via its command-line interface. Before using the `generate` command, ensure you have set your Gemini API key.

```bash
export GEMINI_API_KEY="YOUR_GOOGLE_AI_API_KEY"
```

#### Generate a website from a Brand Brief

This command reads a JSON brief, synthesizes a complete `index.html` and `motion.css` using AI, and saves them to the specified directory.

```bash
# Generate a new site based on the example brief
node tools/generate.mjs --brief ./packages/schemas/examples/brand-brief.example.json --outputDir ./apps/site-example/public/generated --force
```

#### Replicate an existing website

This command crawls a live website, downloads its assets, and creates a local, offline-first copy.

```bash
# Perform a basic replication
node tools/replicator.mjs replicate https://example.com ./replicas/example-site

# Perform a deep crawl with responsive screenshots and Brotli compression
node tools/replicator.mjs replicate https://example.com ./replicas/example-site --depth 3 --responsive --brotli
```

#### Verify a Replica's Integrity

This command checks the SHA-256 hashes of a replicated site against its manifest to ensure no files are corrupted or missing.

```bash
node tools/replicator.mjs verify ./replicas/example-site
```

-----

### 🤝 Contributing

Contributions, issues, and feature requests are welcome. Please feel free to check the issues page and submit a pull request.

### 📄 License

This project is licensed under the **MIT License**.
