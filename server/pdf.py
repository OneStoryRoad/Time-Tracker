from datetime import datetime, timezone
from decimal import Decimal
from io import BytesIO
from xml.sax.saxutils import escape
from pathlib import Path
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    KeepTogether,
)


pdfmetrics.registerFont(
    TTFont("LedgerSans", str(Path(__file__).parent / "fonts" / "DejaVuSans.ttf"))
)


def money(cents, currency):
    return f"{currency} {Decimal(cents) / 100:,.2f}"


def pdf_invoice(invoice, payments):
    out = BytesIO()
    doc = SimpleDocTemplate(
        out,
        pagesize=(8.5 * inch, 11 * inch),
        leftMargin=48,
        rightMargin=48,
        topMargin=46,
        bottomMargin=54,
        title=invoice["number"],
        author=invoice["issuer"]["business"],
    )
    dark = colors.HexColor("#123e38")
    style = ParagraphStyle(
        "body",
        fontName="LedgerSans",
        fontSize=10,
        leading=15,
        textColor=dark,
        spaceAfter=6,
        wordWrap="CJK",
    )
    small = ParagraphStyle("small", parent=style, fontSize=8, leading=12)
    title = ParagraphStyle(
        "title", parent=style, fontSize=30, leading=36, spaceAfter=15
    )

    def para(text, st=style):
        return Paragraph(escape(str(text)).replace("\n", "<br/>"), st)

    currency = invoice["issuer"]["currency"]
    flow = [
        para("VOID INVOICE" if invoice["voided"] else "INVOICE", title),
        para(invoice["number"]),
        Spacer(1, 20),
    ]
    details = Table(
        [
            [para("FROM", small), para("BILL TO", small)],
            [
                para(
                    invoice["issuer"]["business"]
                    + "\n"
                    + invoice["issuer"]["address"]
                    + "\n"
                    + invoice["issuer"]["email"]
                ),
                para(
                    invoice["client"]["name"]
                    + "\n"
                    + invoice["client"]["contact"]
                    + "\n"
                    + invoice["client"]["address"]
                    + "\n"
                    + invoice["client"]["email"]
                ),
            ],
        ],
        colWidths=[258, 258],
    )
    details.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 18),
            ]
        )
    )
    flow += [
        details,
        Spacer(1, 18),
        para(f"Issued {invoice['issued']}     •     Due {invoice['due']}"),
        Spacer(1, 16),
    ]
    rows = [[para(x, small) for x in ("WORK / DATE (UTC)", "HOURS", "RATE", "AMOUNT")]]
    for line in invoice["lines"]:
        day = datetime.fromtimestamp(line["start"] / 1000, timezone.utc).strftime(
            "%b %d, %Y"
        )
        hours = Decimal(line["end"] - line["start"]) / Decimal(3600000)
        rows.append(
            [
                para(day + "\n" + (line["notes"] or "Professional services"), small),
                para(f"{hours:.4f}", small),
                para(money(line["rate"], currency), small),
                para(money(line["amount"], currency), small),
            ]
        )
    table = Table(
        rows, colWidths=[255, 55, 100, 106], repeatRows=1, hAlign="LEFT", splitInRow=1
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8eee5")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 10),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
                ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor("#d6dfd5")),
            ]
        )
    )
    flow += [table, Spacer(1, 20)]
    paid = sum(p["amount"] for p in payments)
    if invoice["voided"]:
        flow += [
            para(f"Voided {invoice['void_date']}: {invoice['void_reason']}"),
            para("This invoice is void. No payment is due."),
        ]
    summary = [
        para("Total: " + money(invoice["total"], currency)),
        para("Payments recorded: " + money(paid, currency)),
        para(
            "Balance due: "
            + money(0 if invoice["voided"] else invoice["total"] - paid, currency)
        ),
        Spacer(1, 10),
        para(invoice["issuer"]["terms"]),
    ]
    flow.append(KeepTogether(summary))
    if payments:
        flow += [Spacer(1, 12), para("Payment history", small)] + [
            para(
                f"{p['date']} · {money(p['amount'], currency)} · {p['reference']}",
                small,
            )
            for p in payments
        ]

    def footer(canvas, doc):
        canvas.setFont("LedgerSans", 8)
        canvas.setFillColor(dark)
        canvas.drawString(48, 30, invoice["number"] + " · Time Ledger")
        canvas.drawRightString(564, 30, f"Page {doc.page}")

    doc.build(flow, onFirstPage=footer, onLaterPages=footer)
    return out.getvalue()
