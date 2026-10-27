import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // (fix 587) ignoreBuildErrors removed: with it production builds were shipped
  // with unchecked types (type errors like isTurbo persisted in prod).
  // Type checking is now executed on every `next build`.
  reactStrictMode: false,
  // (release) Exclude heavy runtimes from output-file-tracing that the
  // application accesses via ABSOLUTE paths at runtime, rather than via
  // require(): ComfyUI (portable Python + source), embedded Python
  // for upscaler, whisper-STT, ffmpeg, and Bonsai build.
  //
  // NOTE: On Windows this option does NOT work — Next joins the pattern with
  // project root via path.join, yielding backslashes, which picomatch
  // interprets as escape characters (verified on Next 16.1.1).
  // These exclusions remain useful on POSIX builds, where path.join
  // produces forward slashes. Bundled runtimes stay separate from the web build.
  outputFileTracingExcludes: {
    '*': [
      'ComfyUI-Easy-Install/**',
      'upscale/bin/**',
      'upscale/logs/**',
      'upscale/jobs/**',
      'stt/**',
      'runtime/**',
      'Bonsai_2_27B/**',
      '.local-input/**',
    ],
  },
  webpack: (config) => {
    // Bundle markdown files (e.g. the H3 prompt guide) as raw source strings.
    // (fix 716) Rule applies ONLY for webpack. In Next 16 default build
    // is Turbopack, and it does NOT recognize webpack() rules
    // (see node_modules/next/dist/docs/.../08-turbopack.md: "Turbopack replaces
    // webpack, so webpack() configs are not recognized"). Therefore dev/build
    // scripts explicitly run with --webpack (package.json), otherwise
    // import './prompt-guide.md' (src/lib/h3-prompt-spec.ts) would lack a loader
    // and dev server would crash on every route importing it.
    if (!config.module) config.module = {};
    if (!config.module.rules) config.module.rules = [];
    config.module.rules.push({
      test: /\.md$/,
      type: "asset/source",
      // Exclude node_modules: without exclude the rule would pull .md from
      // dependencies into bundle as source code.
      exclude: /node_modules/,
    });
    return config;
  },
};

export default nextConfig;
