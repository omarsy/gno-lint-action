import * as core from "@actions/core"
import { exec, ExecOptions } from "child_process"
import path from "path"
import { promisify } from "util"

import { VersionConfig } from "./version"

const execShellCommand = promisify(exec)

export enum InstallMode {
  Binary = "binary",
  GoInstall = "goinstall",
}

type ExecRes = {
  stdout: string
  stderr: string
}

const printOutput = (res: ExecRes): void => {
  if (res.stdout) {
    core.info(res.stdout)
  }
  if (res.stderr) {
    core.info(res.stderr)
  }
}

/**
 * Install golangci-lint.
 *
 * @param versionConfig information about version to install.
 * @param mode          installation mode.
 * @returns             path to installed binary of golangci-lint.
 */
export async function installLint(versionConfig: VersionConfig, mode: InstallMode): Promise<string> {
  core.info(`Installation mode: ${mode}`)

  return goInstall(versionConfig)
}

/**
 * Install golangci-lint via `go install`.
 *
 * @param versionConfig information about version to install.
 * @returns             path to installed binary of golangci-lint.
 */
export async function goInstall(versionConfig: VersionConfig): Promise<string> {
  core.info(`Installing gno-lint ${versionConfig.TargetVersion}...`)

  const startedAt = Date.now()

  const clres = await execShellCommand(`git clone https://github.com/gnolang/gno.git`)
  printOutput(clres)

  const chres = await execShellCommand(`cd gno && git checkout ${versionConfig.TargetVersion}`)
  printOutput(chres)

  const bres = await execShellCommand(`cd gno/gnovm && make build`)
  printOutput(bres)

  const res = await execShellCommand("go env GOPATH")
  printOutput(res)

  // The output of `go install -n` when the binary is already installed is `touch <path_to_the_binary>`.
  const lintPath = path.join(res.stdout.trim(), "bin", "gno")

  core.info(`Installed gno into ${lintPath} in ${Date.now() - startedAt}ms`)

  return lintPath
}
