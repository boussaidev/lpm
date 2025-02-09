# LocalPM (LPM) - The Offline-First Package Manager 🚀

LocalPM is a smart package manager that prioritizes installing npm packages from your local system cache before falling back to online sources. This can significantly speed up package installation and enable offline development when possible.

## Features ✨

- 🔍 Scans your system for existing npm packages
- 📦 Reuses packages from your local cache
- 🌐 Falls back to online installation when needed
- ⚡ Faster installations by avoiding redundant downloads
- 🔄 Compatible with npm, yarn, and pnpm
- 💻 Cross-platform support (Windows, macOS, Linux)

## Installation 🛠️

You can install LocalPM globally:

```bash
npm install -g lpm
```

Or use it directly with npx:

```bash
npx lpm [packages...]
```

## Usage 📚

### Basic Usage

```bash
# Install specific packages
lpm react@17.0.2 react-dom

# Install all dependencies from package.json
lpm

# Install using a specific package manager
lpm express --package-manager yarn

# Install from a specific directory
lpm lodash --root-path /path/to/projects
```

### Command Line Options

```bash
Options:
  --root-path, -r       Custom root directory to scan for packages
  --package-manager, -p  Package manager to use (npm, yarn, pnpm) [default: "npm"]
  --help                Show help information
  --version             Show version number
```

## How It Works 🔄

1. When you request to install a package, LocalPM first scans your system for existing installations
2. If found in the local cache, it copies the package directly to your project
3. If not found locally, it falls back to the specified package manager (npm/yarn/pnpm)
4. Updates your package.json automatically with the installed dependencies

## Benefits 💪

- **Faster Installations**: Reuse existing packages instead of downloading them again
- **Offline Support**: Install packages without internet if they exist in your local cache
- **Bandwidth Saving**: Minimize redundant downloads across projects
- **Package Manager Agnostic**: Works with npm, yarn, and pnpm
- **Version Specific**: Support for installing specific package versions

## Requirements 📋

- Node.js >= 14.16
- npm, yarn, or pnpm installed globally

## Common Use Cases 🎯

```bash
# Install multiple packages
lpm express mongoose dotenv

# Install specific versions
lpm react@17.0.2 react-dom@17.0.2

# Use with yarn
lpm --package-manager yarn next typescript

# Scan specific directory
lpm --root-path ~/projects express
```

## Troubleshooting 🔧

- If a package isn't found locally, LocalPM will automatically fall back to online installation
- Use `--root-path` to specify a different directory to scan for packages
- Make sure you have the necessary permissions to read the system directories

## Contributing 🤝

Contributions are welcome! Please feel free to submit a Pull Request.

## License 📄

MIT License - feel free to use this in your own projects!

## Support 💬

If you encounter any issues or have questions:
- Open an issue on GitHub
- Check the [documentation](https://github.com/yourusername/lpm#readme)
- Submit a pull request with improvements

## Acknowledgments 🙏

Thanks to all the contributors and the npm/yarn/pnpm teams for their amazing work!
