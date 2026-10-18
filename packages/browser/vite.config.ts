import { defineConfig } from 'vite'

// ブラウザ用コンポーネントを、1つの ES モジュール（dist/sealpix.js）にまとめる
export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'sealpix.js',
    },
    target: 'es2022',
    sourcemap: true,
  },
})
