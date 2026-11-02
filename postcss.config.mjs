// EnvGuardCC 的 PostCSS 配置，用于接入 Tailwind CSS 编译全站样式。
import { fileURLToPath } from 'node:url';
const config = {
  plugins: {
    // Keep desktop Rust artifacts and isolated build tools outside automatic source discovery.
    "@tailwindcss/postcss": { base: fileURLToPath(new URL('./src', import.meta.url)) },
  },
};

export default config;
