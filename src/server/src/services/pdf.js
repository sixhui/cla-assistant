// SPDX-FileCopyrightText: 2026 CLA-assistant contributors
//
// SPDX-License-Identifier: Apache-2.0

const PDFDocument = require("pdfkit")
const path = require("path")

const FONT_REGULAR = path.join(__dirname, "..", "..", "assets", "fonts", "NotoSerifCJKsc-Regular.otf")
const FONT_BOLD = path.join(__dirname, "..", "..", "assets", "fonts", "NotoSerifCJKsc-Bold.otf")

const stripMarkdown = (text) => {
    return String(text || "")
        // unescape markdown backslash escapes (e.g. "1\." -> "1."),
        // mirroring GitHub rendering
        .replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, "$1")
        .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, "$1")
        .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/_([^_]+)_/g, "$1")
        .replace(/~~([^~]+)~~/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
}

// Render text with **bold** spans: shield them, strip the remaining
// markdown markers, then emit plain/bold segments on one line.
function renderInline(doc, text, opts) {
    opts = opts || {}
    const bolds = []
    const shielded = String(text || "").replace(/\*\*[^*]+\*\*/g, function (m) {
        bolds.push(m.slice(2, -2))
        return "\u0001B" + (bolds.length - 1) + "\u0001"
    })
    const cleaned = stripMarkdown(shielded)
    const parts = cleaned.split(/(\u0001B\d+\u0001)/g).filter(function (p) { return p !== "" })
    parts.forEach(function (part, idx) {
        const o = Object.assign({}, opts)
        if (idx < parts.length - 1) {
            o.continued = true
        }
        const bm = part.match(/^\u0001B(\d+)\u0001$/)
        if (bm) {
            doc.font(FONT_BOLD).text(bolds[parseInt(bm[1], 10)], o)
        } else {
            doc.font(FONT_REGULAR).text(part, o)
        }
    })
}

// Minimal markdown layout: headings, lists, blockquotes, horizontal rules.
// CLA texts are simple documents; rich rendering is out of scope.
function renderClaText(doc, text) {
    const headingSizes = [20, 16, 14, 12.5, 11.5, 11]
    const lines = String(text || "").split(/\r?\n/)
    lines.forEach((rawLine) => {
        let line = rawLine.trim()
        // a trailing backslash is a markdown hard line break; the line
        // break itself is already preserved by the line-by-line rendering
        line = line.replace(/\\$/, "").trim()
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
            // level-1: centered, bold, large; level-2: centered, bold, body
            // size; deeper headings render as plain body text
            if (match[1].length === 1) {
                doc.font(FONT_BOLD).fontSize(headingSizes[0]).fillColor("#1a3a5c")
                    .text(stripMarkdown(match[2]), { align: "center" })
                doc.moveDown(0.3)
                return
            }
            if (match[1].length === 2) {
                doc.font(FONT_BOLD).fontSize(10.5).fillColor("#222222")
                    .text(stripMarkdown(match[2]), { align: "center" })
                doc.moveDown(0.2)
                return
            }
            doc.font(FONT_REGULAR).fontSize(10.5).fillColor("#222222")
                .text(stripMarkdown(match[2]))
            doc.moveDown(0.2)
            return
        }
        if ((match = line.match(/^[-*+]\s+(.*)$/))) {
            doc.fontSize(10.5).fillColor("#222222")
            renderInline(doc, "\u2022  " + match[1], { indent: 18 })
            doc.moveDown(0.15)
            return
        }
        if ((match = line.match(/^(\d{1,3})[.)]\s+(.*)$/))) {
            doc.fontSize(10.5).fillColor("#222222")
            renderInline(doc, match[1] + ".  " + match[2], { indent: 18 })
            doc.moveDown(0.15)
            return
        }
        if ((match = line.match(/^>\s+(.*)$/))) {
            doc.fontSize(10.5).fillColor("#555555")
            renderInline(doc, match[1], { indent: 18 })
            doc.moveDown(0.15)
            return
        }
        doc.fontSize(10.5).fillColor("#222222")
        renderInline(doc, line)
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

// Replace <key> placeholders in the CLA text with the signatory data.
// Known keys: every custom-field key from the metadata plus user,
// account-name (GitHub login), userId and date (signing date, YYYY-MM-DD).
function fillPlaceholders(text, data) {
    const fields = parseCustomFields(data.customFields)
    const values = {}
    Object.keys(fields).forEach(function (k) { values[k] = fields[k] })
    values.user = data.user
    values["account-name"] = data.user
    values.userId = data.userId
    values.date = data.signedAt ? new Date(data.signedAt).toISOString().slice(0, 10) : ""
    let out = String(text || "")
    Object.keys(values).forEach(function (k) {
        out = out.split("<" + k + ">").join(values[k] == null ? "" : String(values[k]))
    })
    return out
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

const FIELD_LABELS = {
    fullName: "Full Name / \u59d3\u540d",
    email: "Email / \u90ae\u7bb1",
    contributionType: "Contribution Type / \u8d21\u732e\u8eab\u4efd",
    employer: "Employer / \u4f01\u4e1a\u6807\u8bc6"
}

function fieldLabel(key) {
    return FIELD_LABELS[key] || key
}

// Draw the signatory information as a bordered two-column table with a
// shaded header row and per-row height fitted to the wrapped value text.
function renderSignatureTable(doc, rows) {
    const left = doc.page.margins.left
    const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right
    const labelWidth = tableWidth * 0.34
    const valueWidth = tableWidth - labelWidth
    const padX = 10
    const padY = 9

    let y = doc.y

    const drawHeader = () => {
        const headerHeight = 32
        doc.save()
        doc.rect(left, y, tableWidth, headerHeight).fill("#ececec")
        doc.restore()
        doc.font(FONT_BOLD).fontSize(10.5).fillColor("#111111")
        // pdfkit valign is unreliable with CJK fonts (large line boxes), so
        // center manually using the actual single-line height of the font
        const lineH = doc.heightOfString("Ag", { width: valueWidth - 2 * padX })
        const textY = y + Math.max(0, (headerHeight - lineH) / 2)
        doc.text("Field / \u5b57\u6bb5", left + padX, textY,
            { width: labelWidth - 2 * padX, align: "left", lineBreak: false })
        doc.text("Value / \u5185\u5bb9", left + labelWidth + padX, textY,
            { width: valueWidth - 2 * padX, align: "left", lineBreak: false })
        y += headerHeight
    }

    drawHeader()

    rows.forEach(([label, value]) => {
        const valueText = String(value == null || value === "" ? "-" : value)
        const valueHeight = doc.font(FONT_REGULAR).fontSize(10.5)
            .heightOfString(valueText, { width: valueWidth - 2 * padX })
        const rowHeight = valueHeight + 2 * padY

        if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
            doc.addPage()
            y = doc.page.margins.top
            drawHeader()
        }

        doc.font(FONT_REGULAR).fontSize(10).fillColor("#555555")
            .text(label, left + padX, y + padY, { width: labelWidth - 2 * padX, lineBreak: false })
        doc.font(FONT_REGULAR).fontSize(10.5).fillColor("#111111")
            .text(valueText, left + labelWidth + padX, y + padY, { width: valueWidth - 2 * padX })

        const rowEnd = y + rowHeight
        doc.moveTo(left, rowEnd).lineTo(left + tableWidth, rowEnd)
            .lineWidth(0.5).strokeColor("#bbbbbb").stroke()
        doc.moveTo(left + labelWidth, y).lineTo(left + labelWidth, rowEnd)
            .lineWidth(0.5).strokeColor("#bbbbbb").stroke()

        y = rowEnd
    })

    doc.x = left
    doc.y = y
}

function renderSignatureBlock(doc, data) {
    doc.addPage()
    const left = doc.page.margins.left
    const right = doc.page.width - doc.page.margins.right

    doc.font(FONT_BOLD).fontSize(16).fillColor("#111111")
        .text("Signatory Information / \u7b7e\u7f72\u4fe1\u606f", { align: "center" })
    doc.moveDown(0.4)
    doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(1.2).strokeColor("#333333").stroke()
    doc.moveDown(1)

    const fields = parseCustomFields(data.customFields)
    const rows = [
        ["GitHub Account / \u8d26\u53f7", data.user],
        ["GitHub User ID / \u7528\u6237 ID", data.userId]
    ]
    if (fields.fullName) {
        rows.push([fieldLabel("fullName"), fields.fullName])
    }
    if (fields.email) {
        rows.push([fieldLabel("email"), fields.email])
    }
    Object.keys(fields).forEach((key) => {
        if (key === "fullName" || key === "email") {
            return
        }
        rows.push([fieldLabel(key), fields[key]])
    })
    rows.push(["Repository / \u4ed3\u5e93", (data.owner ? data.owner + "/" : "") + (data.repo || "-")])
    rows.push(["CLA Source (Gist)", data.gistUrl])
    rows.push(["CLA Version / \u534f\u8bae\u7248\u672c", data.gistVersion])
    rows.push(["Signed At / \u7b7e\u7f72\u65f6\u95f4", formatDateTime(data.signedAt)])

    renderSignatureTable(doc, rows)

    doc.moveDown(1.4)
    doc.font(FONT_REGULAR).fontSize(9).fillColor("#666666").text(
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


            renderClaText(doc, fillPlaceholders(data.claText, data))

            doc.end()
        } catch (error) {
            reject(error)
        }
    })
}

module.exports = { generateSignaturePdf }
