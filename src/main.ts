import { mount } from 'svelte';
import MainWindow from './windows/MainWindow.svelte';
import PetWindow from './windows/PetWindow.svelte';
import BubbleWindow from './windows/BubbleWindow.svelte';
import { currentWindowLabel } from './lib/tauri';
import './app.css';

// One bundle, three windows. The label decides which view mounts; the browser
// preview has no Tauri internals and always shows the main window.
const label = currentWindowLabel();
const View =
  label === 'pet' ? PetWindow : label === 'bubble' ? BubbleWindow : MainWindow;

const target = document.getElementById('app');
if (!target) throw new Error('Missing app root');
mount(View, { target });
