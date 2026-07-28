#!/usr/bin/env node

/*
 * Copyright (c) 2026 Džiugas Eiva
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * @file Builds the mcp-aggregator container image.
 *
 * Reads build.json, resolves `${VAR}` placeholders in the downstream MCP server configuration
 * against the process environment (optionally seeded from a .env file next to this script),
 * optionally performs an interactive OAuth login for servers that require one, and hands the
 * results to Podman or Docker as build secrets.
 */

const Ajv2020 = require("ajv/dist/2020");
const {createHash} = require("node:crypto");
const {spawnSync} = require("node:child_process");
const {chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} = require("node:fs");
const {tmpdir} = require("node:os");
const {join} = require("node:path");

/**
 * @typedef {{
 *   build: {
 *     engine: string,
 *     name: string,
 *     tag: string,
 *     port?: number,
 *     args: string[],
 *     podman?: { generate_quadlet_unit?: boolean }
 *   },
 *   mcp: {
 *     servers: Record<string, unknown>,
 *     oauth?: string[]
 *   }
 * }} BuildConfig
 */

const ROOT = __dirname;
const BUILD_JSON = join(ROOT, "build.json");
const BUILD_SCHEMA = join(ROOT, "build.schema.json");
const ENV_FILE = join(ROOT, ".env");
const CREDENTIALS_JSON = join(ROOT, "credentials.json");
const STATE_DIR = "/home/mcp/.local/share/mcp-compress-router";
const ajv = new Ajv2020({allErrors: true});

/** @param {string} message @returns {never} */
function fail(message) {
    console.error(message);
    process.exit(1);
}

/** @returns {import("ajv").ValidateFunction} */
function compileValidator() {
    if (!existsSync(BUILD_SCHEMA)) {
        fail(`Schema not found: ${BUILD_SCHEMA}`);
    }

    try {
        return ajv.compile(JSON.parse(readFileSync(BUILD_SCHEMA, "utf8")));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`Failed to parse ${BUILD_SCHEMA}: ${message}`);
    }
}

/** @param {unknown} config */
function assertValidConfig(config) {
    const validate = compileValidator();
    if (!validate(config)) {
        const lines = validate.errors?.map((error) => `  - ${error.instancePath || "/"}: ${error.message}`) ?? [];
        fail(`Invalid build.json:\n${lines.join("\n")}`);
    }
}

/** @returns {BuildConfig} */
function loadBuildConfig() {
    if (!existsSync(BUILD_JSON)) {
        fail(`Build config not found: ${BUILD_JSON}`);
    }

    let config;
    try {
        config = JSON.parse(readFileSync(BUILD_JSON, "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(`Failed to parse ${BUILD_JSON}: ${message}`);
    }

    assertValidConfig(config);
    return /** @type {BuildConfig} */ (config);
}

/**
 * Loads .env from the repository root into the process environment when present.
 * Values already present in the environment take precedence, matching dotenv conventions.
 */
function loadEnvFile() {
    if (!existsSync(ENV_FILE)) {
        return;
    }

    try {
        process.loadEnvFile(ENV_FILE);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(`Failed to load ${ENV_FILE}: ${message}`);
    }
}

/** @param {string[]} args @returns {string[]} */
function buildArgFlags(args) {
    const flags = [];

    for (const arg of args) {
        flags.push("--build-arg", arg);
    }

    return flags;
}

/**
 * @param {string[]} args
 * @param {string} name
 * @returns {string | undefined}
 */
function findBuildArg(args, name) {
    const prefix = `${name}=`;
    return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/**
 * Podman/Docker do not invalidate cached RUN layers when secret file contents change.
 * Hash the baked files so CONFIG_REVISION forces that layer to rebuild.
 *
 * @param {string[]} paths
 * @returns {string}
 */
function configRevisionHash(paths) {
    const hash = createHash("sha256");

    for (const path of paths) {
        hash.update(readFileSync(path, "utf8"));
    }

    return hash.digest("hex").slice(0, 16);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function expandPlaceholders(value) {
    if (typeof value === "string") {
        return value.replace(/\$\{([^}]+)}/g, (_, expression) => {
            const [name, defaultValue] = expression.split(":-");
            const resolved = process.env[name.trim()];

            if (resolved !== undefined && resolved !== "") {
                return resolved;
            }

            if (defaultValue !== undefined) {
                return defaultValue;
            }

            return fail(`Unset placeholder \${${expression}} in mcp.servers; set it in the environment or ${ENV_FILE}`);
        });
    }

    if (Array.isArray(value)) {
        return value.map(expandPlaceholders);
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandPlaceholders(item)]));
    }

    return value;
}

/**
 * @param {string} dir
 * @param {BuildConfig} config
 * @returns {string}
 */
function writeMcpJsonFile(dir, config) {
    const servers = expandPlaceholders(config.mcp.servers);
    const path = join(dir, "mcp.json");
    writeFileSync(path, JSON.stringify({mcpServers: servers}, null, 2) + "\n", {encoding: "utf8", mode: 0o600});
    return path;
}

/**
 * @param {string} store
 * @param {string} server
 * @returns {boolean}
 */
function hasTokens(store, server) {
    try {
        return Boolean(JSON.parse(store)?.[server]?.tokens?.access_token);
    } catch {
        return false;
    }
}

/**
 * Produces the credentials.json seed baked into the image.
 *
 * The authorization-code flow the router implements is interactive, so it cannot run inside a
 * container build. Login therefore runs on the build host and its result is cached in the
 * repository root, keeping later builds non-interactive. Only servers without stored tokens are
 * authorized unless `forceLogin` is set.
 *
 * @param {string} dir
 * @param {BuildConfig} config
 * @param {string} mcpJsonFile
 * @param {boolean} forceLogin
 * @returns {string}
 */
function writeCredentialsFile(dir, config, mcpJsonFile, forceLogin) {
    const path = join(dir, "credentials.json");
    const cached = existsSync(CREDENTIALS_JSON) ? readFileSync(CREDENTIALS_JSON, "utf8") : "{}\n";
    writeFileSync(path, cached, {encoding: "utf8", mode: 0o600});

    const servers = config.mcp.oauth ?? [];
    const pending = forceLogin ? servers : servers.filter((server) => !hasTokens(cached, server));

    if (pending.length === 0) {
        return path;
    }

    const version = findBuildArg(config.build.args, "MCP_ROUTER_VERSION") ?? "latest";
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";

    for (const server of pending) {
        console.log(`Authorizing ${server} with mcp-compress-router@${version}...`);
        const login = spawnSync(npx, ["-y", `mcp-compress-router@${version}`, "-c", mcpJsonFile, "login", server], {stdio: "inherit"});

        if (login.status !== 0) {
            fail(`OAuth login failed for ${server}`);
        }
    }

    if (!existsSync(path)) {
        fail(`Login reported success but stored no credentials for: ${pending.join(", ")}`);
    }

    writeFileSync(CREDENTIALS_JSON, readFileSync(path, "utf8"), "utf8");
    chmodSync(CREDENTIALS_JSON, 0o600);
    console.log(`Cached OAuth credentials in ${CREDENTIALS_JSON}`);
    return path;
}

/**
 * @param {string} root
 * @param {string} image
 * @param {string} name
 * @param {number} port
 * @returns {string}
 */
function writeQuadletFile(root, image, name, port) {
    const path = join(root, `${name}.container`);
    const body = `[Unit]
Description=Local MCP aggregate

[Container]
ContainerName=${name}
Image=${image}
RunInit=true
PublishPort=127.0.0.1:${port}:${port}
Volume=/etc/ssl/certs:/etc/ssl/certs:ro
Volume=${name}-state:${STATE_DIR}

[Service]
Restart=always
RestartSec=5
TimeoutStartSec=300

[Install]
WantedBy=default.target
`;
    writeFileSync(path, body, {encoding: "utf8"});
    return path;
}

process.chdir(ROOT);

loadEnvFile();

const forceLogin = process.argv.includes("--login");
const config = loadBuildConfig();
const engine = config.build.engine.trim();
const name = config.build.name.trim();
const tag = config.build.tag.trim();
const port = config.build.port ?? 20000;
const image = process.env.IMAGE_NAME ?? `${name}:${tag}`;
const secretDir = mkdtempSync(join(tmpdir(), "mcp-aggregator-"));
process.on("exit", () => rmSync(secretDir, {recursive: true, force: true}));

const mcpJsonFile = writeMcpJsonFile(secretDir, config);
const credentialsFile = writeCredentialsFile(secretDir, config, mcpJsonFile, forceLogin);

if (spawnSync(engine, ["--version"], {encoding: "utf8"}).status !== 0) {
    fail(`${engine} not found on PATH`);
}

const configRevision = configRevisionHash([mcpJsonFile, credentialsFile]);
const result = spawnSync(engine, ["build", ...buildArgFlags(config.build.args), "--build-arg", `PORT=${port}`, "--build-arg", `CONFIG_REVISION=${configRevision}`, "--secret", `id=mcp_json,src=${mcpJsonFile}`, "--secret", `id=mcp_credentials,src=${credentialsFile}`, "-t", image, "-f", "Containerfile", ".",], {
    stdio: "inherit",
    cwd: ROOT
},);

if (result.status !== 0) {
    process.exit(result.status ?? 1);
}

if (config.build.podman?.generate_quadlet_unit) {
    if (engine !== "podman") {
        console.warn("build.podman is ignored when build.engine is not podman");
    } else {
        const quadletPath = writeQuadletFile(ROOT, image, name, port);
        console.log(`Wrote quadlet unit ${quadletPath}`);
    }
}
