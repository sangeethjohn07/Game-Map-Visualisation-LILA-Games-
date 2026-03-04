/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        panel: '#1a1f2e',
        surface: '#242938',
        border: '#2e3550',
      },
    },
  },
  plugins: [],
};
