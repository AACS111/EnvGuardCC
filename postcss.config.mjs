// EnvGuardCC 的 PostCSS 配置，用于接入 Tailwind CSS 编译全站样式。
import path from 'node:path';
const config = {
  plugins: {
    // Keep desktop Rust artifacts and isolated build tools outside automatic source discovery.
    // 用 process.cwd() 解析：Turbopack 会把 new URL('./src', import.meta.url) 当模块解析并报 module-not-found。
    "@tailwindcss/postcss": { base: path.resolve(process.cwd(), 'src') },
  },
};

export default config;
