// SPDX-FileCopyrightText: 2026 CLA-assistant contributors
//
// SPDX-License-Identifier: Apache-2.0

// Read-only analytics API for the signature data page. All data comes from
// the local MongoDB (no GitHub communication). Access is limited to the
// configured admin allowlist (see config.api_access.authenticated).

const logger = require("../services/logger")

const mongoose = require("mongoose")

function requireAdmin(req) {
    const adminUsers = config.server.github.admin_users || []
    if (!req.user || (adminUsers.length > 0 && adminUsers.indexOf(req.user.login) < 0)) {
        const err = new Error("Forbidden")
        err.status = 403
        throw err
    }
}

function parseCustomFields(raw) {
    if (!raw) {
        return {}
    }
    try {
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === "object" ? parsed : {}
    } catch (e) {
        return {}
    }
}

function escapeRegex(input) {
    // escape without regex literals (keeps the file shell-transport safe)
    return String(input).replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")
}

class AnalyticsApi {
    async summary(req) {
        requireAdmin(req)
        const CLA = mongoose.model("CLA")
        const Repo = mongoose.model("Repo")
        const [totalSignatures, uniqueSigners, repoCount, latest] = await Promise.all([
            CLA.countDocuments({}),
            CLA.distinct("userId"),
            Repo.countDocuments({}),
            CLA.findOne({}, { created_at: 1 }).sort({ created_at: -1 })
        ])
        return {
            totalSignatures,
            uniqueSigners: uniqueSigners.length,
            linkedRepositories: repoCount,
            latestSignatureAt: latest ? latest.created_at : null
        }
    }

    async repositories(req) {
        requireAdmin(req)
        const Repo = mongoose.model("Repo")
        const CLA = mongoose.model("CLA")
        const repos = await Repo.find({}, { owner: 1, repo: 1, repoId: 1 }).lean()
        const versions = await CLA.distinct("gist_version")
        return { repos, versions }
    }

    async trends(req) {
        requireAdmin(req)
        const CLA = mongoose.model("CLA")
        const days = Math.min(Math.max(parseInt(req.args.days, 10) || 30, 7), 365)
        const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        const match = { created_at: { $gte: from } }
        if (req.args.repoId) {
            match.repoId = String(req.args.repoId)
        }
        const daily = await CLA.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at" } },
                    count: { $sum: 1 },
                    signers: { $addToSet: "$userId" }
                }
            },
            { $project: { count: 1, uniqueSigners: { $size: "$signers" } } },
            { $sort: { _id: 1 } }
        ])
        return { days, daily }
    }

    async signers(req) {
        requireAdmin(req)
        const CLA = mongoose.model("CLA")
        const page = Math.max(parseInt(req.args.page, 10) || 1, 1)
        const pageSize = Math.min(Math.max(parseInt(req.args.pageSize, 10) || 20, 1), 200)

        const query = {}
        if (req.args.repoId) {
            query.repoId = String(req.args.repoId)
        }
        if (req.args.version) {
            query.gist_version = String(req.args.version)
        }
        if (req.args.user) {
            query.user = { $regex: escapeRegex(req.args.user), $options: "i" }
        }
        if (req.args.from || req.args.to) {
            query.created_at = {}
            if (req.args.from) {
                query.created_at.$gte = new Date(req.args.from)
            }
            if (req.args.to) {
                query.created_at.$lte = new Date(req.args.to + "T23:59:59.999Z")
            }
        }

        const [total, records] = await Promise.all([
            CLA.countDocuments(query),
            CLA.find(query, { pdf: 0 })
                .sort({ created_at: -1 })
                .skip((page - 1) * pageSize)
                .limit(pageSize)
                .lean()
        ])

        return {
            total,
            page,
            pageSize,
            records: records.map((r) => ({
                signatureId: String(r._id),
                user: r.user,
                userId: r.userId,
                owner: r.owner,
                repo: r.repo,
                repoId: r.repoId,
                version: r.gist_version,
                signedAt: r.created_at,
                revokedAt: r.revoked_at || null,
                hasPdf: true,
                fields: parseCustomFields(r.custom_fields)
            }))
        }
    }
}

module.exports = new AnalyticsApi()
