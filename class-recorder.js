// OpenCode loader for the class-recorder plugin. OpenCode (1.18.31) only loads plugin files
// sitting directly in ~/.config/opencode/plugins/ (`plugins/*.{js,ts}`); it does not look
// inside sub-folders. Install this file and the class-recorder/ folder side by side there.
export { ClassRecorder } from './class-recorder/index.js';
