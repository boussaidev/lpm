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
import semver from 'semver';

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
          console.log(chalk.red('\n error Failed to kill process:', err.message));
        }
        resolve();
      });
    });
  }
  console.log(chalk.yellow('\n\n info Process interrupted by user'));
  process.exit(0);
});

process.on('SIGTSTP', async () => {
  if (packageManagerProcess) {
    // Kill the process and its children using tree-kill
    await new Promise((resolve) => {
      treeKill(packageManagerProcess.pid, 'SIGKILL', (err) => {
        if (err) {
          console.log(chalk.red('\n error Failed to kill process:', err.message));
        }
        resolve();
      });
    });
  }
  console.log(chalk.yellow('\n\n info Process stopped by user'));
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

  // Filter out dependencies that are already installed
  const depsToSearch = [];
  for (const [depName, depVersion] of dependencySpecs) {
    const localVersion = localPackageJson.dependencies?.[depName];
    const localModuleExists = await fs.pathExists(path.join(localNodeModules, depName));
    
    if (!localVersion || !localModuleExists) {
      depsToSearch.push([depName, depVersion]);
    }
  }

  // If all dependencies are installed, return empty array
  if (depsToSearch.length === 0) {
    return [];
  }

  // Find all package.json files in parallel across root dirs
  const scanSpinner = ora({
    text: 'Scanning system for dependencies...',
    spinner: 'dots',
    color: 'blue'
  }).start();
  
  const packageJsonPathsPromises = rootDirs.map(async rootDir => {
    try {
      scanSpinner.text = `Scanning ${chalk.dim(rootDir)}`;
      const paths = await findPackageJsonInDirectory(rootDir);
      console.log(`${chalk.blue('info')} Found ${paths.length} package.json files in ${chalk.dim(rootDir)}`);
      return paths;
    } catch (err) {
      console.log(`${chalk.yellow('warn')} Unable to scan ${chalk.dim(rootDir)}: ${err.message}`);
      return [];
    }
  });

  const packageJsonPaths = (await Promise.all(packageJsonPathsPromises)).flat();
  scanSpinner.succeed(chalk.blue('info') + ` Found ${packageJsonPaths.length} total package.json files`);

  // Process package.json files in parallel batches
  const batchSize = 50;
  const results = [];
  const seenDeps = new Map(); // Track seen dependency versions and paths
  
  const processSpinner = ora({
    text: 'Analyzing package.json files...',
    spinner: 'dots',
    color: 'blue'
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
            console.log(`${chalk.yellow('warn')} Invalid package.json at ${chalk.dim(packageJsonPath)}: ${parseError.message}`);
            return [];
          }

          const dependencies = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies,
            ...packageJson.peerDependencies,
          };

          const matches = [];
          for (const [depName, depVersion] of depsToSearch) {
            const foundVersion = dependencies[depName];

            if (foundVersion && 
                Object.prototype.hasOwnProperty.call(dependencies, depName) && 
                (!depVersion || foundVersion === depVersion)) {
              
              const depKey = `${depName}@${foundVersion}`;
              const nodeModulesPath = path.join(path.dirname(packageJsonPath), 'node_modules', depName);
              
              try {
                await fs.access(nodeModulesPath);
                
                // If no version specified, track all versions found
                if (!depVersion) {
                  if (!seenDeps.has(depName)) {
                    seenDeps.set(depName, []);
                  }
                  seenDeps.get(depName).push({
                    version: foundVersion.replace(/[\^~]/, ''), // Remove ^ and ~ from version
                    path: nodeModulesPath
                  });
                } else {
                  // If version specified, use first match
                  matches.push({
                    dependency: depName,
                    path: nodeModulesPath,
                    version: foundVersion,
                  });
                  return matches;
                }
              } catch (err) {
                continue;
              }
            }
          }
          processedCount++;
          const progress = Math.round((processedCount / packageJsonPaths.length) * 100);
          processSpinner.text = `[${progress}%] Analyzing files... ${chalk.dim(`${processedCount}/${packageJsonPaths.length}`)}`;
          return matches;
        } catch (err) {
          console.log(`${chalk.yellow('warn')} Could not process ${chalk.dim(packageJsonPath)}: ${err.message}`);
          return [];
        }
      })
    );

    const flatResults = batchResults.flat();
    
    // For dependencies without specified versions, choose latest found version
    for (const [depName, versions] of seenDeps.entries()) {
      if (versions.length > 0) {
        // Sort versions by semver and get latest
        const sorted = versions.sort((a, b) => {
          // Clean versions before comparing
          const cleanA = semver.clean(a.version) || a.version;
          const cleanB = semver.clean(b.version) || b.version;
          return semver.compare(cleanA, cleanB);
        });
        const latest = sorted[sorted.length - 1];
        
        flatResults.push({
          dependency: depName,
          path: latest.path,
          version: latest.version
        });
      }
    }

    if (flatResults.length > 0) {
      results.push(...flatResults);
      break;
    }
  }
  
  processSpinner.succeed(chalk.blue('success') + ' Package analysis complete');
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
    console.log(`${chalk.red('error')} Scanning ${chalk.dim(directory)}: ${error}`);
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
    text: 'Preparing...',
    spinner: 'dots',
    color: 'blue'
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

  copySpinner.succeed(chalk.blue('success') + ' Local environment initialized');

  // Copy each dependency and update package.json
  for (const dep of dependencies) {
    const targetPath = path.join(localNodeModules, dep.dependency);
    const depSpinner = ora({
      text: `Installing ${chalk.cyan(dep.dependency)}...`,
      spinner: 'dots',
      color: 'blue'
    }).start();
    
    try {
      // Check if dependency already exists
      const depExists = await fs.pathExists(targetPath);
      const depInPackageJson = packageJson.dependencies[dep.dependency];

      if (depExists && depInPackageJson) {
        continue;
      }

      // Check if source path is not inside target path to avoid recursive copy
      const relativePath = path.relative(targetPath, dep.path);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        if (depExists) {
          // If module exists but not in package.json, just update package.json
          packageJson.dependencies[dep.dependency] = dep.version;
          depSpinner.succeed(chalk.blue('success') + ` Added ${chalk.cyan(dep.dependency)} to package.json`);
        } else {
          // Copy module and update package.json
          await fs.remove(targetPath); // Clean up any partial files
          await fs.copy(dep.path, targetPath, { overwrite: true });
          packageJson.dependencies[dep.dependency] = dep.version;
          depSpinner.succeed(chalk.blue('success') + ` Installed ${chalk.cyan(dep.dependency)}@${dep.version}`);
        }
      } else {
        depSpinner.fail(chalk.red('error') + ` Cannot install ${chalk.cyan(dep.dependency)}: Invalid source location`);
      }
    } catch (err) {
      if (err.code === 'EXDEV') {
        depSpinner.info(chalk.blue('info') + ` ${dep.dependency} is already installed`);
      } else {
        depSpinner.fail(chalk.red('error') + ` Failed to install ${chalk.cyan(dep.dependency)}: ${err.message}`);
      }
    }
  }

  // Write updated package.json
  try {
    await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
    console.log(chalk.blue('success') + ' Updated package.json');
  } catch (err) {
    console.log(chalk.red('error') + ' Failed to update package.json:', err.message);
  }

  // Find dependencies that weren't found offline
  const foundDeps = new Set(dependencies.map(d => d.dependency));
  const missingDeps = allDependencies.filter(d => !foundDeps.has(d.split('@')[0]));

  if (missingDeps.length > 0) {
    console.log(chalk.blue('info') + ` Installing remaining dependencies using ${packageManager}...`);
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
            console.log(chalk.blue('success') + ' Installed remaining dependencies');
            resolve();
          } else {
            reject(new Error(`${packageManager} install exited with code ${code}`));
          }
        });
        
        packageManagerProcess.on('error', reject);
      });

    } catch (err) {
      console.log(chalk.red('error') + ` Failed to install remaining dependencies: ${err.message}`);
    } finally {
      packageManagerProcess = null;
    }
  }
}

// Display welcome message
console.log(chalk.bold.blue('\nLocalPM v1.0.0'));

// Parse command-line arguments using yargs
const argv = yargs(hideBin(process.argv))
  .usage(chalk.dim('Usage: $0 [packages...] [options]'))
  .option('root-path', {
    alias: 'r',
    type: 'string',
    description: 'Custom root directory to scan for packages',
  })
  .option('package-manager', {
    alias: 'p',
    type: 'string',
    description: 'Package manager to use (npm, yarn, pnpm)',
    choices: ['npm', 'yarn', 'pnpm'],
    default: 'npm'
  })
  .example('$0 react@17.0.2 react-dom', 'Install specific React version and react-dom')
  .example('$0 lodash --root-path /path/to/projects', 'Install lodash from specific directory')
  .example('$0 express --package-manager yarn', 'Install express using Yarn')
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
        console.log(chalk.blue('info') + ' No dependencies found in package.json');
        process.exit(0);
      }

      console.log(chalk.blue('info') + ' Found dependencies in package.json:');
      depsToSearch.forEach(dep => console.log(chalk.dim(`  ${dep}`)));
      
    } catch (err) {
      console.log(chalk.red('error') + ' No package.json found and no packages specified');
      process.exit(1);
    }
  }

  console.log(chalk.blue('info') + ' Searching for packages in local cache...');
  const results = await getDependencyPaths(depsToSearch, customRootDir);

  if (results.length === 0) {
    console.log(chalk.blue('info') + ` No packages found in cache, falling back to ${packageManager}...`);
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
            console.log(chalk.blue('success') + ` Installed packages using ${packageManager}`);
            resolve();
          } else {
            reject(new Error(`${packageManager} install exited with code ${code}`));
          }
        });
        
        packageManagerProcess.on('error', reject);
      });

      process.exit(0);
    } catch (err) {
      console.log(chalk.red('error') + ` Installation failed: ${err.message}`);
      process.exit(1);
    } finally {
      packageManagerProcess = null;
    }
  }

  console.log(chalk.blue('info') + ' Found packages in cache:');
  results.forEach(result => {
    console.log(chalk.dim(`  ${result.dependency}@${result.version} from ${result.path}`));
  });

  // Copy dependencies to local node_modules and update package.json
  await copyDependenciesToLocal(results, depsToSearch, packageManager);
})();
