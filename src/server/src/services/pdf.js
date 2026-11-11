// SPDX-FileCopyrightText: 2026 CLA-assistant contributors
//
// SPDX-License-Identifier: Apache-2.0

const PDFDocument = require("pdfkit")
const path = require("path")

const FONT_PATH = path.join(__dirname, "..", "..", "assets", "fonts", "wqy-microhei.ttf")

const stripMarkdown = (text) => {
    return String(text || "")
        .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, "$1")
        .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/_([^_]+)_/g, "$1")
        .replace(/~~([^~]+)~~/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
}

// Minimal markdown layout: headings, lists, blockquotes, horizontal rules.
// CLA texts are simple documents; rich rendering is out of scope.
function renderClaText(doc, text) {
    const headingSizes = [20, 16, 14, 12.5, 11.5, 11]
    const lines = String(text || "").split(/\r?\n/)
    lines.forEach((rawLine) => {
        const line = rawLine.trim()
        let match
        if (!line) {
            doc.moveDown(0.5)
            return
        }
        if (line.match(/^([-*_])\1{2,}\s*$/)) {
            doc.moveDown(0.5)
            doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y)
                .lineWidth(0.7).strokeColor("#999999").stroke()
            doc.moveDown(0.8)
            return
        }
        if ((match = line.match(/^(#{1,6})\s+(.*)$/))) {
            const size = headingSizes[match[1].length - 1] || 11
            doc.moveDown(0.7)
            doc.fontSize(size).fillColor("#111111").text(stripMarkdown(match[2]))
            doc.moveDown(0.3)
            return
        }
        if ((match = line.match(/^[-*+]\s+(.*)$/))) {
            doc.fontSize(10.5).fillColor("#222222").text("\u2022  " + stripMarkdown(match[1]), { indent: 18 })
            doc.moveDown(0.15)
            return
        }
        if ((match = line.match(/^(\d{1,3})[.)]\s+(.*)$/))) {
            doc.fontSize(10.5).fillColor("#222222").text(match[1] + ".  " + stripMarkdown(match[2]), { indent: 18 })
            doc.moveDown(0.15)
            return
        }
        if ((match = line.match(/^>\s+(.*)$/))) {
            doc.fontSize(10.5).fillColor("#555555").text(stripMarkdown(match[1]), { indent: 18 })
            doc.moveDown(0.15)
            return
        }
        doc.fontSize(10.5).fillColor("#222222").text(stripMarkdown(line))
        doc.moveDown(0.2)
    })
}

function formatDateTime(date) {
    if (!date) return "-"
    const d = new Date(date)
    const pad = (n) => String(n).padStart(2, "0")
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
        " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) + " UTC"
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

function renderRow(doc, label, value) {
    doc.moveDown(0.35)
    doc.font(FONT_PATH).fontSize(10.5).fillColor("#666666").text(label, { continued: true, width: 150 })
    doc.font(FONT_PATH).fontSize(10.5).fillColor("#111111").text(String(value == null || value === "" ? "-" : value), { indent: 150 })
}

function renderSignatureBlock(doc, data) {
    doc.addPage()
    const left = doc.page.margins.left
    const right = doc.page.width - doc.page.margins.right

    doc.font(FONT_PATH).fontSize(16).fillColor("#111111").text("Signatory Information / \u7b7e\u7f72\u4fe1\u606f", { align: "center" })
    doc.moveDown(0.6)
    doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(1.2).strokeColor("#333333").stroke()
    doc.moveDown(0.8)

    const fields = parseCustomFields(data.customFields)
    renderRow(doc, "GitHub Account", data.user)
    renderRow(doc, "GitHub User ID", data.userId)
    if (fields.fullName) renderRow(doc, "Full Name / \u59d3\u540d", fields.fullName)
    if (fields.email) renderRow(doc, "Email / \u90ae\u7bb1", fields.email)
    Object.keys(fields).forEach((key) => {
        if (key === "fullName" || key === "email") return
        renderRow(doc, key, fields[key])
    })
    renderRow(doc, "Repository", (data.owner ? data.owner + "/" : "") + (data.repo || "-"))
    renderRow(doc, "CLA Source (Gist)", data.gistUrl)
    renderRow(doc, "CLA Version", data.gistVersion)
    renderRow(doc, "Signed At", formatDateTime(data.signedAt))

    doc.moveDown(1.2)
    doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.7).strokeColor("#999999").stroke()
    doc.moveDown(0.8)
    doc.font(FONT_PATH).fontSize(9).fillColor("#666666").text(
        "This document was generated automatically by CLA-assistant when the signatory accepted the " +
        "contributor license agreement above. It combines the CLA text of the referenced version with " +
        "the signatory information provided at the time of signature.",
        { align: "justify" }
    )
}

// Generate the signed CLA document (CLA text + signatory information) as a PDF buffer.
function generateSignaturePdf(data) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: "A4",
                margins: { top: 64, bottom: 64, left: 64, right: 64 },
                info: {
                    Title: "Signed CLA - " + data.user,
                    Author: "CLA-assistant",
                    Subject: "Contributor License Agreement signed by " + data.user
                }
            })
            const chunks = []
            doc.on("data", (chunk) => chunks.push(chunk))
            doc.on("end", () => resolve(Buffer.concat(chunks)))
            doc.on("error", reject)

            doc.font(FONT_PATH).fontSize(18).fillColor("#111111")
                .text("Contributor License Agreement / \u8d21\u732e\u8005\u8bb8\u53ef\u534f\u8bae", { align: "center" })
            if (data.owner || data.repo) {
                doc.moveDown(0.3)
                doc.font(FONT_PATH).fontSize(11).fillColor("#555555")
                    .text("Repository: " + (data.owner ? data.owner + "/" : "") + (data.repo || "-"), { align: "center" })
            }
            doc.moveDown(0.4)
            doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y)
                .lineWidth(1.2).strokeColor("#333333").stroke()
            doc.moveDown(0.8)

            renderClaText(doc, data.claText)

            renderSignatureBlock(doc, data)

            doc.end()
        } catch (error) {
            reject(error)
        }
    })
}

module.exports = { generateSignaturePdf }
