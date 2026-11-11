// SPDX-FileCopyrightText: 2026 CLA-assistant contributors
//
// SPDX-License-Identifier: Apache-2.0

const nodemailer = require("nodemailer")
const logger = require("./logger")

let transporter = null

function getTransporter() {
    if (!config.server.smtp.enabled) {
        return null
    }
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: config.server.smtp.host,
            port: config.server.smtp.port,
            secure: config.server.smtp.secure,
            auth: config.server.smtp.auth.user ? {
                user: config.server.smtp.auth.user,
                pass: config.server.smtp.auth.pass
            } : undefined,
            name: config.server.smtp.name
        })
    }
    return transporter
}

function getAdminEmails() {
    return String(config.server.smtp.admin_emails || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
}

function parseCustomFields(raw) {
    if (!raw) return {}
    try {
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === "object" ? parsed : {}
    } catch (e) {
        return {}
    }
}

// Notify the signatory (custom field "email") and the configured admin
// addresses about a completed signature. Never throws: mailing problems are
// logged and must not break the signing flow.
async function sendSignatureEmail(signature, pdfBuffer) {
    const transporter = getTransporter()
    if (!transporter) {
        logger.info("SMTP is not configured, skip signature notification email")
        return
    }

    const fields = parseCustomFields(signature.custom_fields)
    const to = fields.email ? [fields.email] : []
    if (to.length === 0) {
        logger.warn("Signature email skipped: no email address in custom fields of " + signature.user)
        return
    }
    const bcc = getAdminEmails()

    const repoLabel = (signature.owner ? signature.owner + "/" : "") + (signature.repo || "")
    const subject = "[CLA] Signed contributor license agreement" + (repoLabel ? " - " + repoLabel : "")
    const body =
        "Hello " + (fields.fullName || signature.user) + ",\n\n" +
        "This is an automated confirmation that the contributor license agreement has been signed " +
        "electronically. The signed document (PDF) is attached.\n\n" +
        "GitHub account: " + signature.user + "\n" +
        (repoLabel ? "Repository: " + repoLabel + "\n" : "") +
        "Signed at: " + new Date(signature.created_at).toISOString() + "\n" +
        "CLA version: " + signature.gist_version + "\n\n" +
        "If you did not sign this agreement, please contact the repository maintainers.\n"

    const message = {
        from: config.server.smtp.from || config.server.smtp.auth.user,
        to: to.join(","),
        subject: subject,
        text: body,
        attachments: [{
            filename: "signed-cla-" + signature.user + ".pdf",
            content: pdfBuffer,
            contentType: "application/pdf"
        }]
    }
    if (bcc.length > 0) {
        message.bcc = bcc.join(",")
    }

    const info = await transporter.sendMail(message)
    logger.info("Signature notification email sent to " + to.join(",") +
        (bcc.length > 0 ? " (bcc " + bcc.length + " admins)" : "") +
        ", response: " + info.response)
    return info
}

module.exports = { sendSignatureEmail }
