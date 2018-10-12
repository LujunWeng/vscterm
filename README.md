# VSC Terminal
Hacking [VS Code](https://github.com/Microsoft/vscode) to make the integrated terminal work as an standalone app.

## Instruction
### Build and Run
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
![demo](https://media.giphy.com/media/555tC2i1BUZUufW8Lf/giphy.gif)
* [x] Hide other parts in the workbench and let the Panel take up the whole window.
* :runner: Remove not used services for unrelevant parts like Status Bar etc.
* [x] Remove buildin language extensions to reduce the size of setup
* :runner: Figure out how to integrate latest vs code

## License
Licensed under the [MIT](LICENSE.txt) License.
