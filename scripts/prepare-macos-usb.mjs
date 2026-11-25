import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin') {
  throw new Error('The universal macOS USB binding preparation step must run on macOS.');
}

const usbPackage = JSON.parse(await readFile(resolve('node_modules/usb/package.json'), 'utf8'));
const outputDirectory = resolve('node_modules/@node-usb');
const bindings = [
  { packageName: '@node-usb/usb-darwin-x64', binary: 'usb.darwin-x64.node' },
  { packageName: '@node-usb/usb-darwin-arm64', binary: 'usb.darwin-arm64.node' },
];

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', rejectPromise);
    child.once('exit', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(command + ' exited with ' + code + '.')));
  });
}

for (const binding of bindings) {
  const version = usbPackage.optionalDependencies?.[binding.packageName];
  if (!version) throw new Error(binding.packageName + ' is not declared by the installed usb package.');

  const packageDirectory = join(outputDirectory, binding.packageName.slice('@node-usb/'.length));
  const binaryPath = join(packageDirectory, binding.binary);
  try {
    await readFile(binaryPath);
    continue;
  } catch {
    // The package manager omits the other CPU architecture's optional binary.
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'webglow-usb-binding-'));
  try {
    await mkdir(packageDirectory, { recursive: true });
    await run('npm', ['pack', binding.packageName + '@' + version, '--pack-destination', temporaryDirectory]);
    const archive = (await readdir(temporaryDirectory)).find((name) => name.endsWith('.tgz'));
    if (!archive) throw new Error('npm pack did not create an archive for ' + binding.packageName + '.');
    await run('tar', ['-xzf', join(temporaryDirectory, archive), '-C', packageDirectory, '--strip-components=1']);
    await readFile(binaryPath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

console.log('Both Intel and Apple Silicon uDMX USB bindings are ready for universal packaging.');
