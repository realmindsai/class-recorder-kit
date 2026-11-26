# Class recorder kit

Read [NOTICE.md](NOTICE.md) first. It says what the recorder records and why.

## 1. Install OpenCode 1.18.31

This exact version is the one the recorder was tested with. It needs Node.js (https://nodejs.org, the LTS version).

```
npm install -g opencode-ai@1.18.31
opencode --version
```

## 2. Get the kit

Download https://github.com/realmindsai/class-recorder-kit/archive/refs/heads/main.zip and unzip it.

## 3. Install the recorder

Copy **both** `class-recorder.js` and the `class-recorder` folder into your OpenCode plugins folder. Create the folder if it doesn't exist.

- macOS and Linux: `~/.config/opencode/plugins/`
- Windows: `%USERPROFILE%\.config\opencode\plugins\`

Tell git your name, the way you want Dennis to see it:

```
git config --global user.name "Your Name"
```

## 4. Start OpenCode in your class folder

Close OpenCode. OpenCode works in whatever folder your terminal is in, and can read and change the files there. Make a folder for the class and always start OpenCode from inside it.

macOS and Linux:

```
mkdir -p ~/class
cd ~/class
opencode
```

Windows: open PowerShell normally, **not** "Run as administrator", then run:

```
New-Item -ItemType Directory -Force "$env:USERPROFILE\class"
cd "$env:USERPROFILE\class"
opencode
```

If your prompt shows `C:\Windows\System32`, you are in the wrong folder. Run the `cd` line first.

Type `hello`.

**Done when:** Dennis sees your name.

**To remove it:** delete `class-recorder.js` and the `class-recorder` folder from the plugins folder.
