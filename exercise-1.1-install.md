## Install the class recorder

Dennis gives you two items: a file called `class-recorder.js` and a folder called `class-recorder`. Dennis will read `NOTICE.md` out in class. You can read it yourself too. It says what the recorder does.

1. Copy **both** `class-recorder.js` and the `class-recorder` folder into your OpenCode plugins folder. Create the folder if it doesn't exist.
   - macOS and Linux: `~/.config/opencode/plugins/`
   - Windows: `%USERPROFILE%\.config\opencode\plugins\`. To create it, run this in PowerShell:
     `New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins"`
2. Tell git your real name, the way you want Dennis to see it:
   `git config --global user.name "Your Name"`
3. Close OpenCode and open it again.
4. Ask OpenCode anything, for example "hello".

**Done when:** Dennis sees your name in the console.

To stop recording later, delete `class-recorder.js` and the `class-recorder` folder from your plugins folder.
