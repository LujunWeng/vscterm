# VSC Terminal
Hacking [VS Code](https://github.com/Microsoft/vscode) (based on v1.23.2) to make the integrated terminal work as an standalone app.

## Usage
Similar to the original integrated terminal. `Quick Open` is kept and some commands can be access through it.

For example, if you want to select the default shell in Windows, Press `F1` and Input `Select Default Shell`.

Also, if the terminal does not show up in some cases, Press `F1` and Input `Toggle Integrated Terminal`

The location of setting file is similar to VS Code.
```
Windows: %APPDATA%\vscterm\User\settings.json
macOS: $HOME/Library/Application Support/vscterm/User/settings.json
Linux: $HOME/.config/vscterm/User/settings.json
```

## Build and Run
Refers to [Code's contribution page](https://github.com/Microsoft/vscode/wiki/How-to-Contribute)

Or, to put it simply:

In one terminal
```
yarn
yarn run watch
```

In another terminal

`./scripts/code.bat` or `./scripts/code.sh`

## Progress
![demo](https://media.giphy.com/media/5aWCHpEBOIHLqduPP0/giphy.gif)
* [x] Hide other parts in the workbench and let the Panel take up the whole window.
* :runner: Remove not used services for unrelevant parts like Status Bar etc.
* [x] Remove buildin language extensions to reduce the size of setup
* :runner: Figure out how to integrate latest vs code

## License
Licensed under the [MIT](LICENSE.txt) License.
