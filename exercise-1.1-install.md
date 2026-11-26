## Install the class recorder

Dennis gives you two items: a file called `class-recorder.js` and a folder called `class-recorder`. Dennis will read `NOTICE.md` out in class. You can read it yourself too. It says what the recorder does.

1. Copy **both** `class-recorder.js` and the `class-recorder` folder into your OpenCode plugins folder. Create the folder if it doesn't exist.
   - macOS and Linux: `~/.config/opencode/plugins/`
   - Windows: `%USERPROFILE%\.config\opencode\plugins\`. To create it, run this in PowerShell:
     `New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugins"`
2. Tell git your real name, the way you want Dennis to see it:
   `git config --global user.name "Your Name"`
3. Close OpenCode. Make a folder for the class and start OpenCode from inside it. OpenCode works in whatever folder your terminal is in, and can read and change the files there, so always start it from this folder.
   - macOS and Linux:
     `mkdir -p ~/class && cd ~/class && opencode`
   - Windows: open PowerShell normally, **not** "Run as administrator", then run:
     `New-Item -ItemType Directory -Force "$env:USERPROFILE\class"; cd "$env:USERPROFILE\class"; opencode`

   If your prompt shows `C:\Windows\System32`, you are in the wrong folder. Run the `cd` part first.
4. Ask OpenCode anything, for example "hello".

**Done when:** Dennis sees your name in the console.

To stop recording later, delete `class-recorder.js` and the `class-recorder` folder from your plugins folder.
