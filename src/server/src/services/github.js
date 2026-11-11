// SPDX-FileCopyrightText: 2022 SAP SE or an SAP affiliate company and CLA-assistant contributors
//
// SPDX-License-Identifier: Apache-2.0

const cache = require('memory-cache')
const config = require('../config')
const stringify = require('json-stable-stringify')
const logger = require('../services/logger')

const { Octokit } = require('@octokit/rest')
const { createAppAuth } = require('@octokit/auth-app')
const { createOAuthAppAuth } = require('@octokit/auth-oauth-app');

const OctokitWithPluginsAndDefaults = Octokit.plugin(
    require('@octokit/plugin-retry').retry,
    require('@octokit/plugin-throttling').throttling,
    require('./octokit-plugins/custom-endpoints').reposGetById,
    require('./octokit-plugins/network-interceptor').rateLimitLogger,
).defaults({
    protocol: config.server.github.protocol,
    version: config.server.github.version,
    host: config.server.github.api,
    pathPrefix: config.server.github.enterprise ? '/api/v3' : null,
    userAgent: 'CLA assistant',
    throttle: {
        onRateLimit: (retryAfter, options) => {
            logger.info(`Request quota exhausted for request ${options.method} ${options.url}`)
            if (options.request.retryCount === 0) { // only retries once
                logger.info(`Retrying after ${retryAfter} seconds!`)
                return true
            }
        },
        onAbuseLimit: (retryAfter, options) => {
            // does not retry, only logs a warning
            logger.info(`Abuse detected for request ${options.method} ${options.url}`)
        }
    }
})

async function callGithub(octokit, obj, fun, arg, cacheKey, cacheTime) {
    if (cacheKey && !config.server.nocache) {
        const cachedRes = cache.get(cacheKey)
        if (cachedRes) {
            logger.info(`Result returned from cache for ${obj}.${fun}`)
            return cachedRes
        }
    }
    let res
    if (fun.match(/list.*/g)) {
        const options = octokit[obj][fun].endpoint.merge(arg)
        res = {
            data: await octokit.paginate(options)
        }
    } else {
        res = await octokit[obj][fun](arg)
        // logger.info(`Result for ${obj}.${fun}`)
    }

    if (res && cacheTime) {
        cache.put(cacheKey, res, 1000 * cacheTime)
    }

    return res
}

function determineAuthentication(token, basicAuth) {
    if (token) {
        return { auth: `token ${token}` }
    }
    // basic Auth means that we want to act as the OAuthApp
    if (basicAuth) {
        return {
            authStrategy: createOAuthAppAuth,
            auth: {
                clientId: basicAuth.user,
                clientSecret: basicAuth.pass
            }
        }
    }
    // if nothing matches we return an empty object, so we have the same types
    return {}
}

async function getInstallationForUser(username) {
    const JWToctokit = new OctokitWithPluginsAndDefaults({
        authStrategy: createAppAuth,
        auth: config.server.github.app
    })
    const result = await callGithub(JWToctokit, 'apps', 'getUserInstallation', { username })
    return result
}

async function getInstallationForRepo(owner, repo) {
    const JWToctokit = new OctokitWithPluginsAndDefaults({
        authStrategy: createAppAuth,
        auth: config.server.github.app
    })
    const result = await callGithub(JWToctokit, 'apps', 'getRepoInstallation', {
        owner,
        repo
     })
    return result
}

async function getInstallationForOrg(org) {
    const JWToctokit = new OctokitWithPluginsAndDefaults({
        authStrategy: createAppAuth,
        auth: config.server.github.app
    })
    const result = await callGithub(JWToctokit, 'apps', 'getOrgInstallation', {
        org,
    })
    return result
}

// Installation tokens are valid for one hour and the installation mapping
// barely changes; cache both to avoid two extra serial round trips (lookup
// + token exchange) in front of every single GitHub App API call.
const installationCache = new Map() // key -> { value, expiresAt }
const INSTALLATION_TTL_MS = 10 * 60 * 1000
const TOKEN_SAFETY_MS = 5 * 60 * 1000

function cacheGet(key) {
    const entry = installationCache.get(key)
    if (entry && entry.expiresAt > Date.now()) {
        return entry.value
    }
    return null
}

function cacheSet(key, value, ttlMs) {
    installationCache.set(key, { value, expiresAt: Date.now() + ttlMs })
    if (installationCache.size > 200) {
        const firstKey = installationCache.keys().next().value
        installationCache.delete(firstKey)
    }
}

async function getInstallationAccessTokenByInstallationID(installation_id) {
    const cacheKey = 'token:' + installation_id
    const cached = cacheGet(cacheKey)
    if (cached) {
        return cached
    }
    const JWToctokit = new OctokitWithPluginsAndDefaults({
        authStrategy: createAppAuth,
        auth: config.server.github.app
    })
    const result = await callGithub(JWToctokit, 'apps', 'createInstallationAccessToken', { installation_id })
    const data = result.data || {}
    const expiresAt = data.expires_at ? Date.parse(data.expires_at) : (Date.now() + 50 * 60 * 1000)
    // hand back the token while it still has enough lifetime left
    cacheSet(cacheKey, data.token, Math.max(60 * 1000, expiresAt - Date.now() - TOKEN_SAFETY_MS))
    return data.token
}

async function getInstallationAccessTokenForUser(username) {
    const instKey = 'inst:user:' + username
    let installationId = cacheGet(instKey)
    if (!installationId) {
        const installation = await getInstallationForUser(username)
        installationId = installation.data.id
        cacheSet(instKey, installationId, INSTALLATION_TTL_MS)
    }
    return await getInstallationAccessTokenByInstallationID(installationId)
}

async function getInstallationAccessTokenForRepo(owner, repo) {
    const installation = await getInstallationForRepo(owner, repo)
    return await getInstallationAccessTokenByInstallationID(installation.data.id)
}

async function getInstallationAccessTokenForOrg(org) {
    const installation = await getInstallationForOrg(org)
    return await getInstallationAccessTokenByInstallationID(installation.data.id)
}

const githubService = {
    resetList: {},

    call: async (call) => {
        const arg = call.arg || {}
        const fun = call.fun
        const obj = call.obj
        const cacheKey = generateCacheKey(arg, obj, fun, call.token)

        const { auth, authStrategy } = determineAuthentication(call.token, call.basicAuth)

        const octokit = new OctokitWithPluginsAndDefaults({ auth, authStrategy })

        if (!obj || !octokit[obj]) {
            throw new Error(`${obj} required/object not found or specified`)
        }

        if (!fun || !octokit[obj][fun]) {
            throw new Error(`${obj}.${fun} required/function not found or specified`)
        }

        try {
            return callGithub(octokit, obj, fun, arg, cacheKey, arg.cacheTime)
        } catch (error) {
            logger.info(`${error} - Error on callGithub.${obj}.${fun} with args ${arg}.`)
            throw new Error(error)
        }
    },

    callGraphql: async (query, token) => {
        const octokit = new OctokitWithPluginsAndDefaults({ auth: token })
        const response = await octokit.graphql(query.query, query.variables)
        // workaround as the other functions expect the response body in the data attribute
        // TODO: refactor probably
        return { data: response }
    },

    getInstallationAccessTokenForUser,
    getInstallationAccessTokenByInstallationID,
    getInstallationAccessTokenForOrg,
    getInstallationAccessTokenForRepo,
    getInstallationForUser,
    getInstallationForRepo,
    getInstallationForOrg,

    callWithGitHubApp: async (request, throwError = false, printLog = true) => {
        try {
            const username = request.owner
            delete request.owner
            const token = await getInstallationAccessTokenForUser(username)
            request.token = token
            if (printLog) logger.info(request)
        } catch (error) {
            if (throwError) {
                throw error
            }
            logger.error(error);
        }
        return githubService.call(request);
    },

    callGraphqlWithGitHubApp: async (query, token) => {
        try {
            const username = query.owner
            delete query.owner
            const ghsToken = await getInstallationAccessTokenForUser(username)
            token = ghsToken
            logger.info(query)
        } catch (error) {
            logger.error(error);
        }
        return githubService.callGraphql(query, token);
    }
}

module.exports = githubService

function generateCacheKey(arg, obj, fun, token) {
    const argWithoutCacheParams = Object.assign({}, arg)
    delete argWithoutCacheParams.cacheTime
    return stringify({
        obj,
        fun,
        arg: argWithoutCacheParams,
        token
    })
}
