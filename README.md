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

Close OpenCode, open it again, and type `hello`.

**Done when:** Dennis sees your name.

**To remove it:** delete `class-recorder.js` and the `class-recorder` folder from the plugins folder.
