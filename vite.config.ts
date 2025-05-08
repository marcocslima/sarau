// vite.config.ts
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      // define: { // Se você tiver variáveis de ambiente do frontend
      //   'process.env.API_KEY': JSON.stringify(env.API_KEY)
      // },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, './src'), // Se você usar a pasta src
        }
      },
      build: {
        rollupOptions: {
          input: {
            main: path.resolve(__dirname, 'index.html'),
            upload: path.resolve(__dirname, 'upload.html')
          }
        }
      },
      server: { // Para desenvolvimento local, proxy para a API
        proxy: {
          '/api': {
            target: 'http://localhost:3001', // URL do seu backend local
            changeOrigin: true,
            // rewrite: (path) => path.replace(/^\/api/, '') // Se o backend não espera /api no início
          }
        }
      }
    };
});