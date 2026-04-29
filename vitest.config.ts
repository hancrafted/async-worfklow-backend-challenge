import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "interview/archive/**"],
    environment: "node",
  },
  // Vitest's default esbuild transform does not emit `design:type` decorator
  // metadata, which TypeORM's `@Column()` (no explicit type) relies on. SWC
  // does emit it. See interview/design_decisions.md §Task 1.
  plugins: [
    swc.vite({
      jsc: {
        target: "es2020",
        parser: { syntax: "typescript", decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
    }),
  ],
});
