import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://teamchong.github.io",
  base: "/gomode",
  integrations: [
    starlight({
      title: "gomode",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/teamchong/gomode",
        },
      ],
      sidebar: [
        { label: "Overview", slug: "index" },
        { label: "Getting Started", slug: "getting-started" },
        {
          label: "Architecture",
          items: [
            { label: "Three Layers", slug: "architecture/three-layers" },
            { label: "Worker vs DO", slug: "architecture/worker-vs-do" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Writing Handlers", slug: "guides/writing-handlers" },
            { label: "Zero-Copy Data", slug: "guides/zero-copy" },
          ],
        },
        { label: "Benchmarks", slug: "benchmarks" },
      ],
    }),
  ],
});
