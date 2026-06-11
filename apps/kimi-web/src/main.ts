import { createApp } from 'vue';
import App from './App.vue';
import i18n from './i18n';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './style.css';

createApp(App).use(i18n).mount('#app');
