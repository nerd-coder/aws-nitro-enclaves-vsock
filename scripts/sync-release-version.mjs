import { readFileSync, writeFileSync } from 'node:fs'

const packageJsonPath = 'package.json'
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
const { name, version } = packageJson

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Expected semver package version, got "${version}"`)
}

const nativePackagePrefix = `${name}-`

if (packageJson.optionalDependencies) {
  for (const dependencyName of Object.keys(packageJson.optionalDependencies)) {
    if (dependencyName.startsWith(nativePackagePrefix)) {
      packageJson.optionalDependencies[dependencyName] = version
    }
  }
}

writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, '\t')}\n`)
console.log(`Synchronized native optional dependency versions to ${version}`)
