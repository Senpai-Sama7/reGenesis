
import * as React from "react";

export function SkipLink(){
  return (
    <a href="#main" className="sr-only focus:not-sr-only focus:outline focus:outline-2 focus:outline-offset-2">
      Skip to content
    </a>
  );
}

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>){
  return (
    <button
      {...props}
      className={
        "inline-flex items-center justify-center rounded-lg px-4 py-2 focus:outline-2 focus:outline-offset-2 " +
        "bg-[color:var(--color-accent,#4da3ff)] text-white hover:opacity-90 " +
        (props.className || "")
      }
    />
  );
}

export function Section(props: React.HTMLAttributes<HTMLElement>){
  return (
    <section
      {...props}
      className={`fade-in ${props.className ?? ""}`}
      style={{ padding: "var(--space, 12px)", ...(props.style||{}) }}
    />
  );
}

export function Nav({ items }: { items: { href: string; label: string }[] }){
  return (
    <nav aria-label="Primary">
      <ul className="flex gap-4">
        {items.map(it => (
          <li key={it.href}>
            <a href={it.href} className="focus:outline-2 focus:outline-offset-2 underline">
              {it.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
