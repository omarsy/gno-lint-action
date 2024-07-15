import * as core from "@actions/core"
import * as github from "@actions/github"
import { Context } from "@actions/github/lib/context"
import { exec, ExecOptions } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { dir } from "tmp"
import { promisify } from "util"

import { restoreCache, saveCache } from "./cache"
import { installLint, InstallMode } from "./install"
import { alterDiffPatch } from "./utils/diffUtils"

const execShellCommand = promisify(exec)
const writeFile = promisify(fs.writeFile)
const createTempDir = promisify(dir)

function isOnlyNewIssues(): boolean {
  return core.getBooleanInput(`only-new-issues`, { required: true })
}

async function prepareLint(): Promise<string> {
  const mode = core.getInput("install-mode").toLowerCase()
  const v: string = core.getInput(`version`) || "latest"

  return await installLint(v, <InstallMode>mode)
}

async function fetchPatch(): Promise<string> {
  if (!isOnlyNewIssues()) {
    return ``
  }

  const ctx = github.context

  switch (ctx.eventName) {
    case `pull_request`:
    case `pull_request_target`:
      return await fetchPullRequestPatch(ctx)
    case `push`:
      return await fetchPushPatch(ctx)
    case `merge_group`:
      return ``
    default:
      core.info(`Not fetching patch for showing only new issues because it's not a pull request context: event name is ${ctx.eventName}`)
      return ``
  }
}

async function fetchPullRequestPatch(ctx: Context): Promise<string> {
  const pr = ctx.payload.pull_request
  if (!pr) {
    core.warning(`No pull request in context`)
    return ``
  }

  const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }))

  let patch: string
  try {
    const patchResp = await octokit.rest.pulls.get({
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      [`pull_number`]: pr.number,
      mediaType: {
        format: `diff`,
      },
    })

    if (patchResp.status !== 200) {
      core.warning(`failed to fetch pull request patch: response status is ${patchResp.status}`)
      return `` // don't fail the action, but analyze without patch
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    patch = patchResp.data as any
  } catch (err) {
    console.warn(`failed to fetch pull request patch:`, err)
    return `` // don't fail the action, but analyze without patch
  }

  try {
    const tempDir = await createTempDir()
    const patchPath = path.join(tempDir, "pull.patch")
    core.info(`Writing patch to ${patchPath}`)
    await writeFile(patchPath, alterDiffPatch(patch))
    return patchPath
  } catch (err) {
    console.warn(`failed to save pull request patch:`, err)
    return `` // don't fail the action, but analyze without patch
  }
}

async function fetchPushPatch(ctx: Context): Promise<string> {
  const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }))

  let patch: string
  try {
    const patchResp = await octokit.rest.repos.compareCommitsWithBasehead({
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      basehead: `${ctx.payload.before}...${ctx.payload.after}`,
      mediaType: {
        format: `diff`,
      },
    })

    if (patchResp.status !== 200) {
      core.warning(`failed to fetch push patch: response status is ${patchResp.status}`)
      return `` // don't fail the action, but analyze without patch
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    patch = patchResp.data as any
  } catch (err) {
    console.warn(`failed to fetch push patch:`, err)
    return `` // don't fail the action, but analyze without patch
  }

  try {
    const tempDir = await createTempDir()
    const patchPath = path.join(tempDir, "push.patch")
    core.info(`Writing patch to ${patchPath}`)
    await writeFile(patchPath, alterDiffPatch(patch))
    return patchPath
  } catch (err) {
    console.warn(`failed to save pull request patch:`, err)
    return `` // don't fail the action, but analyze without patch
  }
}

type Env = {
  lintPath: string
  patchPath: string
}

async function prepareEnv(): Promise<Env> {
  const startedAt = Date.now()

  // Prepare cache, lint and go in parallel.
  await restoreCache()

  const lintPath = await prepareLint()
  const patchPath = await fetchPatch()

  core.info(`Prepared env in ${Date.now() - startedAt}ms`)

  return { lintPath, patchPath }
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

async function runLint(lintPath: string): Promise<void> {
  const debug = core.getInput(`debug`)
  if (debug.split(`,`).includes(`cache`)) {
    const res = await execShellCommand(`${lintPath} cache status`)
    printOutput(res)
  }

  const addedArgs: string[] = []

  const problemMatchers = core.getBooleanInput(`problem-matchers`)

  if (problemMatchers) {
    const matchersPath = path.join(__dirname, "../..", "problem-matchers.json")
    if (fs.existsSync(matchersPath)) {
      // Adds problem matchers.
      // https://github.com/actions/setup-go/blob/cdcb36043654635271a94b9a6d1392de5bb323a7/src/main.ts#L81-L83
      core.info(`##[add-matcher]${matchersPath}`)
    }
  }

  const cmdArgs: ExecOptions = {}

  const workingDirectory = core.getInput(`working-directory`)
  if (workingDirectory) {
    if (!fs.existsSync(workingDirectory) || !fs.lstatSync(workingDirectory).isDirectory()) {
      throw new Error(`working-directory (${workingDirectory}) was not a path`)
    }

    cmdArgs.cwd = path.resolve(workingDirectory)
  }

  const cmd = `${lintPath} lint ${addedArgs.join(` `)}`.trimEnd()

  core.info(`Running [${cmd}] in [${cmdArgs.cwd || process.cwd()}] ...`)

  const startedAt = Date.now()
  try {
    const res = await execShellCommand(cmd, cmdArgs)
    printOutput(res)
    core.info(`gnoci-lint found no issues`)
  } catch (exc) {
    // This logging passes issues to GitHub annotations but comments can be more convenient for some users.
    // TODO: support reviewdog or leaving comments by GitHub API.
    printOutput(exc)

    if (exc.code === 1) {
      core.setFailed(`issues found`)
    } else {
      core.setFailed(`gnoci-lint exit with code ${exc.code}`)
    }
  }

  core.info(`Ran gnoci-lint in ${Date.now() - startedAt}ms`)
}

export async function run(): Promise<void> {
  try {
    const { lintPath } = await core.group(`prepare environment`, prepareEnv)
    core.addPath(path.dirname(lintPath))
    await core.group(`run gnoci-lint`, () => runLint(lintPath))
  } catch (error) {
    core.error(`Failed to run: ${error}, ${error.stack}`)
    core.setFailed(error.message)
  }
}

export async function postRun(): Promise<void> {
  try {
    await saveCache()
  } catch (error) {
    core.error(`Failed to post-run: ${error}, ${error.stack}`)
    core.setFailed(error.message)
  }
}
