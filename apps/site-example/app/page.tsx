
"use client";
import { useEffect } from "react";
import { SkipLink, Button, Section, Nav } from "@cyberarchitect/ui";
import { initLenis, syncWithScrollTrigger } from "@cyberarchitect/scroll";

export default function Page(){
  useEffect(() => { const lenis = initLenis({ smooth: true, duration: 1.2 }); syncWithScrollTrigger(lenis); }, []);
  return (
    <>
      <SkipLink />
      <header style={{ padding: "var(--space, 12px)" }} aria-label="Site header">
        <Nav items={[{ href: "#features", label: "Features" }, { href: "#cta", label: "Get started" }]} />
      </header>
      <main id="main">
        <Section aria-labelledby="h1">
          <p className="text-sm opacity-80">Private • Fast</p>
          <h1 id="h1">CyberArchitect Example</h1>
          <p>Generate or replicate sites with one CLI.</p>
          <p><a href="/generated/index.html">Open generated demo</a></p>
          <Button onClick={() => alert("Hello")}>Click</Button>
        </Section>
        <Section id="features">
          <h2>Features</h2>
          <ul>
            <li>AI-driven static HTML synthesis</li>
            <li>Smooth scrolling and motion primitives</li>
            <li>Website replication & integrity manifest</li>
          </ul>
        </Section>
        <Section id="cta">
          <h2>Get started</h2>
          <pre>npm run generate -- --brief ./packages/schemas/examples/brand-brief.example.json --outputDir ./apps/site-example/public/generated --force</pre>
        </Section>
      </main>
      <script dangerouslySetInnerHTML={{__html:`
        (function(){
          if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
          const io = new IntersectionObserver((entries) => {
            for (const e of entries) if (e.isIntersecting) e.target.classList.add('in-view');
          }, { threshold: 0.2 });
          document.querySelectorAll('.fade-in').forEach(el => io.observe(el));
        })();
      `}} />
    </>
  );
}
