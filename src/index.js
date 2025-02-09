#!/usr/bin/env node

import path from 'path';
import fs from 'fs-extra';
import { glob } from 'glob';
import os from 'os';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';
import figlet from 'figlet';
import { spawn } from 'child_process';
import treeKill from 'tree-kill';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Handle Ctrl+C and Ctrl+Z
let packageManagerProcess = null;

process.on('SIGINT', async () => {
  if (packageManagerProcess) {
    // Kill the process and its children using tree-kill
    await new Promise((resolve) => {
      treeKill(packageManagerProcess.pid, 'SIGKILL', (err) => {
        if (err) {
          console.log(chalk.red('\n❌ Failed to kill process:', err.message));
        }
        resolve();
      });
    });
  }
  console.log(chalk.yellow('\n\n🛑 Process interrupted by user (Ctrl+C)'));
  process.exit(0);
});

process.on('SIGTSTP', async () => {
  if (packageManagerProcess) {
    // Kill the process and its children using tree-kill
    await new Promise((resolve) => {
      treeKill(packageManagerProcess.pid, 'SIGKILL', (err) => {
        if (err) {
          console.log(chalk.red('\n❌ Failed to kill process:', err.message));
        }
        resolve();
      });
    });
  }
  console.log(chalk.yellow('\n\n⏸️  Process stopped by user (Ctrl+Z)'));
  process.exit(0);
});

/**
 * Function to get the dependencies' paths and versions across the entire system and copy them locally.
 * @param {string[]} dependencyNames - The names of the dependencies to search for.
 * @param {string} [customRootDir] - Optional custom root directory to scan.
 * @returns {Promise<Array<{dependency: string, path: string, version: string}>>} - List of paths and versions of the dependencies.
 */
async function getDependencyPaths(dependencyNames, customRootDir) {
  // Get root directories to scan based on OS or custom dir
  const rootDirs = [];
  if (customRootDir) {
    rootDirs.push(customRootDir);
  } else if (process.platform === 'win32') {
    // Windows: scan all drives
    const drives = await fs.readdir('\\\\.\\');
    rootDirs.push(...drives.map(drive => `${drive}:\\`));
  } else {
    // Unix-like: scan from root
    rootDirs.push('/');
  }

  // Parse dependency names and versions once upfront
  const dependencySpecs = new Map(dependencyNames.map(dep => {
    const [name, version] = dep.split('@');
    return [name, version];
  }));

  // Check local package.json and node_modules first
  const localPackageJsonPath = path.join(process.cwd(), 'package.json');
  const localNodeModules = path.join(process.cwd(), 'node_modules');
  let localPackageJson;
  try {
    localPackageJson = await fs.readJson(localPackageJsonPath);
  } catch (err) {
    localPackageJson = { dependencies: {} };
  }

  // Find all package.json files in parallel across root dirs
  const scanSpinner = ora({
    text: 'Starting system-wide dependency scan...',
    spinner: 'dots',
    color: 'magenta'
  }).start();
  
  const packageJsonPathsPromises = rootDirs.map(async rootDir => {
    try {
      scanSpinner.text = `Scanning ${chalk.cyan(rootDir)} for dependencies...`;
      const paths = await findPackageJsonInDirectory(rootDir);
      console.log(`${chalk.green('✨')} Located ${chalk.bold.magenta(paths.length)} package.json files in ${chalk.cyan(rootDir)}`);
      return paths;
    } catch (err) {
      console.log(`${chalk.yellow('⚠')} Warning: Unable to scan ${chalk.cyan(rootDir)}: ${err.message}`);
      return [];
    }
  });

  const packageJsonPaths = (await Promise.all(packageJsonPathsPromises)).flat();
  scanSpinner.succeed(chalk.green(`🎯 Located ${chalk.bold.magenta(packageJsonPaths.length)} total package.json files`));

  // Process package.json files in parallel batches
  const batchSize = 50;
  const results = [];
  const seenDeps = new Map(); // Track seen dependency versions
  
  const processSpinner = ora({
    text: '📦 Analyzing package.json files...',
    spinner: 'dots',
    color: 'cyan'
  }).start();
  
  let processedCount = 0;
  
  for (let i = 0; i < packageJsonPaths.length; i += batchSize) {
    const batch = packageJsonPaths.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async packageJsonPath => {
        try {
          // Skip if path contains nested node_modules
          if (packageJsonPath.match(/node_modules.*node_modules/)) {
            return [];
          }

          let packageJson;
          try {
            packageJson = await fs.readJson(packageJsonPath);
          } catch (parseError) {
            console.log(`${chalk.yellow('⚠')} Warning: Invalid package.json at ${chalk.cyan(packageJsonPath)}: ${parseError.message}`);
            return [];
          }

          const dependencies = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies,
            ...packageJson.peerDependencies,
          };

          const matches = [];
          for (const [depName, depVersion] of dependencySpecs) {
            const foundVersion = dependencies[depName];
            const localVersion = localPackageJson.dependencies?.[depName];
            const localModuleExists = await fs.pathExists(path.join(localNodeModules, depName));

            // Skip if dependency exists both in package.json and node_modules
            if (localVersion && localModuleExists) {
              continue;
            }

            if (foundVersion && 
                Object.prototype.hasOwnProperty.call(dependencies, depName) && 
                (!depVersion || foundVersion === depVersion)) {
              
              const depKey = `${depName}@${foundVersion}`;
              if (seenDeps.has(depKey)) continue;
              
              const nodeModulesPath = path.join(path.dirname(packageJsonPath), 'node_modules', depName);
              
              try {
                await fs.access(nodeModulesPath);
                matches.push({
                  dependency: depName,
                  path: nodeModulesPath,
                  version: foundVersion,
                });
                seenDeps.set(depKey, true);
              } catch (err) {
                continue;
              }
            }
          }
          processedCount++;
          const progress = Math.round((processedCount / packageJsonPaths.length) * 100);
          processSpinner.text = `📦 Analyzing files... ${chalk.cyan(`${processedCount}/${packageJsonPaths.length}`)} [${progress}%]`;
          return matches;
        } catch (err) {
          console.log(`${chalk.yellow('⚠')} Warning: Could not process ${chalk.cyan(packageJsonPath)}: ${err.message}`);
          return [];
        }
      })
    );
    results.push(...batchResults.flat());
  }
  
  processSpinner.succeed(chalk.green('🚀 Package analysis complete!'));
  return results;
}

/**
 * Function to search for all package.json files in the directory and subdirectories.
 * @param {string} directory - The directory to search in.
 * @returns {Promise<string[]>} - List of paths to package.json files found in the directory.
 */
async function findPackageJsonInDirectory(directory) {
  try {
    const files = await glob(path.join(directory, '**/package.json'), {
      nodir: true,
      follow: false,
      ignore: [
        '**/node_modules/**/node_modules/**',
        '**/.*/**',
        '**/tmp/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/test/**',
      ],
      absolute: true,
      cache: true,
      dot: false
    });
    return files;
  } catch (error) {
    console.log(`${chalk.red('✗')} Error scanning ${chalk.cyan(directory)}: ${error}`);
    return [];
  }
}

/**
 * Function to copy dependency to local node_modules and update package.json
 * @param {Array<{dependency: string, path: string, version: string}>} dependencies - Dependencies to copy
 * @param {string[]} allDependencies - All dependencies that were requested
 * @param {string} packageManager - Package manager to use (npm, yarn, pnpm)
 */
async function copyDependenciesToLocal(dependencies, allDependencies, packageManager) {
  const copySpinner = ora({
    text: '🔄 Preparing local environment...',
    spinner: 'dots',
    color: 'yellow'
  }).start();
  
  // Ensure node_modules exists
  const localNodeModules = path.join(process.cwd(), 'node_modules');
  await fs.ensureDir(localNodeModules);

  // Read local package.json
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  let packageJson;
  try {
    packageJson = await fs.readJson(packageJsonPath);
  } catch (err) {
    packageJson = { dependencies: {} };
  }

  if (!packageJson.dependencies) {
    packageJson.dependencies = {};
  }

  copySpinner.succeed(chalk.green('📦 Local environment initialized'));

  // Copy each dependency and update package.json
  for (const dep of dependencies) {
    const targetPath = path.join(localNodeModules, dep.dependency);
    const depSpinner = ora({
      text: `📥 Installing ${chalk.cyan(dep.dependency)} from local cache...`,
      spinner: 'dots',
      color: 'magenta'
    }).start();
    
    try {
      // Check if dependency already exists
      const depExists = await fs.pathExists(targetPath);
      const depInPackageJson = packageJson.dependencies[dep.dependency];

      if (depExists && depInPackageJson) {
        depSpinner.info(chalk.blue(`📌 ${dep.dependency} is already installed locally`));
        continue;
      }

      // Check if source path is not inside target path to avoid recursive copy
      const relativePath = path.relative(targetPath, dep.path);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        if (depExists) {
          // If module exists but not in package.json, just update package.json
          packageJson.dependencies[dep.dependency] = dep.version;
          depSpinner.succeed(chalk.green(`📝 Added ${chalk.cyan(dep.dependency)} to package.json`));
        } else {
          // Copy module and update package.json
          await fs.remove(targetPath); // Clean up any partial files
          await fs.copy(dep.path, targetPath, { overwrite: true });
          packageJson.dependencies[dep.dependency] = dep.version;
          depSpinner.succeed(chalk.green(`✨ Successfully installed ${chalk.cyan(dep.dependency)} from cache`));
        }
      } else {
        depSpinner.fail(chalk.red(`❌ Cannot install ${chalk.cyan(dep.dependency)}: Invalid source location`));
      }
    } catch (err) {
      if (err.code === 'EXDEV') {
        depSpinner.info(chalk.blue(`📌 ${dep.dependency} is already installed`));
      } else {
        depSpinner.fail(chalk.red(`❌ Failed to install ${chalk.cyan(dep.dependency)}: ${err.message}`));
      }
    }
  }

  // Write updated package.json
  try {
    await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
    console.log(chalk.green('\n✨ Successfully updated package.json'));
  } catch (err) {
    console.log(chalk.red('\n❌ Failed to update package.json:', err.message));
  }

  // Find dependencies that weren't found offline
  const foundDeps = new Set(dependencies.map(d => d.dependency));
  const missingDeps = allDependencies.filter(d => !foundDeps.has(d.split('@')[0]));

  if (missingDeps.length > 0) {
    console.log(chalk.yellow(`\n📡 Installing remaining dependencies using ${packageManager}...`));
    try {
      const installCommands = {
        npm: ['install'],
        yarn: ['add'],
        pnpm: ['add']
      };

      // Use spawn instead of execSync to properly handle signals
      packageManagerProcess = spawn(packageManager, [...installCommands[packageManager], ...missingDeps], {
        stdio: 'inherit',
        detached: true // Create new process group
      });

      await new Promise((resolve, reject) => {
        packageManagerProcess.on('close', (code) => {
          if (code === 0) {
            console.log(chalk.green('✨ Successfully installed remaining dependencies'));
            resolve();
          } else {
            reject(new Error(`${packageManager} install exited with code ${code}`));
          }
        });
        
        packageManagerProcess.on('error', reject);
      });

    } catch (err) {
      console.log(chalk.red(`\n❌ Failed to install remaining dependencies: ${err.message}`));
    } finally {
      packageManagerProcess = null;
    }
  }
}

// Display welcome message with gradient colors
const title = figlet.textSync('LocalPM', {
  font: 'ANSI Shadow',
  horizontalLayout: 'fitted'
});

const header = boxen(
  chalk.bold.cyan(title) +
  '\n\n' + chalk.magenta('🚀 The Offline-First Package Manager 🚀') +
  '\n' + chalk.yellow('Install npm packages from your local system cache') +
  '\n\n' + chalk.dim('Version 1.0.0'),
  {
    padding: { left: 4, right: 4, top: 1, bottom: 1 },
    margin: { top: 1, bottom: 1 },
    borderStyle: 'double',
    borderColor: 'cyan',
    backgroundColor: '#1a1a1a',
    float: 'center',
    title: '💫 Welcome 💫',
    titleAlignment: 'center'
  }
);

console.log(header);

// Parse command-line arguments using yargs
const argv = yargs(hideBin(process.argv))
  .usage(chalk.cyan('🚀 Usage: $0 [packages...] [options]'))
  .option('root-path', {
    alias: 'r',
    type: 'string',
    description: '📁 Custom root directory to scan for packages',
  })
  .option('package-manager', {
    alias: 'p',
    type: 'string',
    description: '📦 Package manager to use (npm, yarn, pnpm)',
    choices: ['npm', 'yarn', 'pnpm'],
    default: 'npm'
  })
  .example(chalk.green('$0 react@17.0.2 react-dom'), 'Install specific React version and react-dom')
  .example(chalk.green('$0 lodash --root-path /path/to/projects'), 'Install lodash from specific directory')
  .example(chalk.green('$0 express --package-manager yarn'), 'Install express using Yarn')
  .help()
  .argv;

const dependencyNames = argv._;
const customRootDir = argv.rootPath;
const packageManager = argv.packageManager;

(async () => {
  let depsToSearch = dependencyNames;

  if (dependencyNames.length === 0) {
    // If no deps provided, read from package.json
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    try {
      const packageJson = await fs.readJson(packageJsonPath);
      const dependencies = packageJson.dependencies || {};
      
      depsToSearch = Object.entries(dependencies).map(([name, version]) => {
        return version.startsWith('^') || version.startsWith('~') ? 
          name : 
          `${name}@${version}`;
      });

      if (depsToSearch.length === 0) {
        console.log(chalk.yellow('📭 No dependencies found in package.json'));
        process.exit(0);
      }

      console.log(chalk.cyan('\n📦 Found dependencies in package.json:'));
      depsToSearch.forEach(dep => console.log(chalk.green(`  ⭐ ${dep}`)));
      
    } catch (err) {
      console.log(chalk.red('❌ No package.json found and no packages specified'));
      process.exit(1);
    }
  }

  console.log(chalk.cyan('\nSearching for packages in local cache...'));
  const results = await getDependencyPaths(depsToSearch, customRootDir);

  if (results.length === 0) {
    console.log(chalk.yellow(`\n📡 No packages found in cache, falling back to ${packageManager}...`));
    try {
      const installCommands = {
        npm: ['install'],
        yarn: ['add'],
        pnpm: ['add']
      };

      // Use spawn instead of execSync
      packageManagerProcess = spawn(packageManager, [...installCommands[packageManager], ...depsToSearch], {
        stdio: 'inherit',
        detached: true // Create new process group
      });

      await new Promise((resolve, reject) => {
        packageManagerProcess.on('close', (code) => {
          if (code === 0) {
            console.log(chalk.green(`✨ Successfully installed packages using ${packageManager}`));
            resolve();
          } else {
            reject(new Error(`${packageManager} install exited with code ${code}`));
          }
        });
        
        packageManagerProcess.on('error', reject);
      });

      process.exit(0);
    } catch (err) {
      console.log(chalk.red(`\n❌ Installation failed: ${err.message}`));
      process.exit(1);
    } finally {
      packageManagerProcess = null;
    }
  }

  console.log(chalk.green('\n🎉 Found packages in cache:'));
  results.forEach(result => {
    console.log(boxen(
      `${chalk.bold.cyan(result.dependency)}\n` +
      `${chalk.dim('📁 Location:')} ${chalk.magenta(result.path)}\n` +
      `${chalk.dim('📌 Version:')} ${chalk.green(result.version)}`,
      { 
        padding: 1,
        margin: { top: 1 },
        borderColor: 'cyan',
        borderStyle: 'round',
        float: 'center'
      }
    ));
  });

  // Copy dependencies to local node_modules and update package.json
  await copyDependenciesToLocal(results, depsToSearch, packageManager);
})();
