import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname);

export default defineConfig({
  envDir: path.join(projectRoot, '.vite-env'),
  publicDir: false,
  resolve: {
    alias: {
      '#time': path.join(projectRoot, 'utils', 'time', 'timeModule.js'),
    },
  },
  build: {
    emptyOutDir: false,
    copyPublicDir: false,
    outDir: path.join(projectRoot, 'public', 'assets', 'js'),
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      input: {
        'home-react': path.join(projectRoot, 'public', 'js', 'apps', 'homeReactApp.js'),
        'login-react': path.join(projectRoot, 'public', 'js', 'apps', 'loginReactApp.js'),
        'user-password-reset-react': path.join(projectRoot, 'public', 'js', 'apps', 'userPasswordResetReactApp.js'),
        'user-react': path.join(projectRoot, 'public', 'js', 'apps', 'userReactApp.js'),
        'commands-react': path.join(projectRoot, 'public', 'js', 'apps', 'commandsReactApp.js'),
        'terms-react': path.join(projectRoot, 'public', 'js', 'apps', 'termsReactApp.js'),
        'api-docs': path.join(projectRoot, 'public', 'js', 'apps', 'apiDocsApp.js'),
        'stickers-react': path.join(projectRoot, 'public', 'js', 'apps', 'stickersApp.js'),
        'create-pack-react': path.join(projectRoot, 'public', 'js', 'apps', 'createPackApp.js'),
        'stickers-admin': path.join(projectRoot, 'public', 'js', 'apps', 'stickersAdminApp.js'),
        'user-systemadm': path.join(projectRoot, 'public', 'js', 'apps', 'userApp.js'),
      },
      output: {
        format: 'es',
        entryFileNames: '[name].bundle.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
