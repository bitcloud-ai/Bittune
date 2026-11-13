"""Render saved report claims and sign the PDF with a private local identity."""
from __future__ import annotations

import io
import json
import re
from datetime import datetime, timedelta, timezone
from html import escape

from bittune_core.contracts import ContractError


def _identity(store):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    directory = store.home / "report-signing"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    key_path, cert_path = directory / "key.pem", directory / "certificate.pem"
    if key_path.exists() != cert_path.exists():
        raise ContractError("signing_identity_incomplete", "报告签名身份不完整；请恢复原私钥和证书，不会自动替换身份。")
    if not key_path.exists():
        key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Bittune local report signer")])
        now = datetime.now(timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                .public_key(key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=3650))
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True,
                    key_encipherment=False, data_encipherment=False, key_agreement=False,
                    key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
                .sign(key, hashes.SHA256()))
        key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        key_path.chmod(0o600)
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        cert_path.chmod(0o644)
    cert_bytes = cert_path.read_bytes()
    cert = x509.load_pem_x509_certificate(cert_bytes)
    return key_path, cert_path, cert_bytes, "sha256:" + cert.fingerprint(hashes.SHA256()).hex()


def _render(fact, fingerprint):
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import SimpleDocTemplate, Paragraph, LongTable, TableStyle

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    body = ParagraphStyle("body", fontName="STSong-Light", fontSize=10, leading=16,
                          wordWrap="CJK", alignment=TA_LEFT, spaceAfter=7)
    small = ParagraphStyle("small", parent=body, fontSize=8, leading=12)
    title = ParagraphStyle("title", parent=body, fontSize=19, leading=27, spaceAfter=15, textColor=colors.HexColor("#124d37"))
    heading = ParagraphStyle("heading", parent=body, fontSize=13, leading=20, spaceBefore=13, textColor=colors.HexColor("#124d37"))
    def text(value, style=body):
        # Keep Latin metrics independent of reader-specific CID font substitution.
        parts = re.split(r"([\x00-\xff]+)", str("" if value is None else value))
        markup = "".join(f'<font name="Helvetica">{escape(part)}</font>' if part and ord(part[0]) <= 255 else escape(part)
                         for part in parts)
        return Paragraph(markup.replace("\n", "<br/>"), style)
    r = fact["payload"]
    story = [text("Bittune 部署调优报告", heading), text(r["title"], title),
             text(r["report_id"], small), text("原报告摘要：" + fact["content_hash"], small),
             text("原报告创建时间：" + r.get("created_at", "未提供") + "；原叙述按该版本保留。", small),
             text("签名证书指纹：" + fingerprint, small),
             text("本机自签证书：用于核对文件完整性及本机签名身份，不代表外部CA认证或可信时间戳。", small)]
    for label, key in (("范围", "scope"), ("结论", "conclusion"), ("叙述与限制", "narrative")):
        story.append(text(label, heading))
        for paragraph in (r.get(key) or "未提供").split("\n\n"):
            story.append(text(paragraph))
    claims = r.get("suite_claims", []) + r.get("metric_claims", [])
    if claims:
        story.append(text("实测指标（原生引用）", heading))
        rows = [[text(v, small) for v in ("指标", "实测值", "场景/并发/重复", "来源")]]
        for c in claims:
            rows.append([text(c.get("label") or c.get("metric"), small),
                text(c.get("display", c.get("value", "未提供")), small),
                text(f"{c.get('scenario_id', '—')} / {c.get('concurrency', '—')} / {c.get('repeat', '—')}", small),
                text(c.get("suite_result_id") or c.get("benchmark_result_id"), small)])
        table = LongTable(rows, colWidths=[105, 80, 110, 216], repeatRows=1, hAlign="LEFT")
        table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef5ef")),
            ("LINEBELOW", (0, 0), (-1, -1), 0.3, colors.HexColor("#d5dfd7")),
            ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5)]))
        story.append(table)
    for key, label in (("predicted_claims", "预测来源（不是实测）"), ("pd_claims", "P/D推算（不是集群实测）")):
        if r.get(key):
            story.append(text(label, heading))
            for claim in r[key]:
                story.append(text(json.dumps(claim, ensure_ascii=False), small))
    story.append(text("事实来源", heading))
    for kind, refs in r.get("references", {}).items():
        for ref in refs:
            story.append(text(f"{kind}: {ref['id']}\n{ref.get('content_hash', '')}", small))
    output = io.BytesIO()
    doc = SimpleDocTemplate(output, pagesize=A4, leftMargin=42, rightMargin=42,
        topMargin=42, bottomMargin=42, title=r["title"], author="Bittune Core")
    def footer(canvas, _document):
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#52645a"))
        canvas.drawString(42, 25, "Bittune | " + r["report_id"])
        canvas.drawRightString(A4[0] - 42, 25, str(canvas.getPageNumber()))
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()


def verify_signed_pdf(content, certificate):
    from asn1crypto import pem, x509
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    cert = x509.Certificate.load(pem.unarmor(certificate)[2])
    reader = PdfFileReader(io.BytesIO(content))
    signatures = reader.embedded_signatures
    if len(signatures) != 1:
        raise ContractError("pdf_signature_invalid", "PDF必须包含唯一的本机报告签名。")
    status = validate_pdf_signature(signatures[0], signer_validation_context=ValidationContext(
        trust_roots=[cert], allow_fetching=False))
    return {"document_intact": status.intact, "cryptographically_valid": status.valid,
            "trusted_with_supplied_certificate": status.trusted,
            "coverage": status.coverage.name, "external_ca_trusted": False,
            "trust_mode": "local_self_signed", "trusted_timestamp": False}


def signed_report_pdf(store, fact):
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import fields, signers

    key, cert, cert_bytes, fingerprint = _identity(store)
    signer = signers.SimpleSigner.load(str(key), str(cert))
    unsigned = _render(fact, fingerprint)
    result = io.BytesIO()
    signers.PdfSigner(signers.PdfSignatureMetadata(field_name="BittuneReportSignature",
        certify=True, docmdp_permissions=fields.MDPPerm.NO_CHANGES,
        reason="Bittune source report " + fact["content_hash"]), signer=signer).sign_pdf(
            IncrementalPdfFileWriter(io.BytesIO(unsigned)), output=result)
    content = result.getvalue()
    verification = verify_signed_pdf(content, cert_bytes)
    if not verification["document_intact"] or not verification["cryptographically_valid"]:
        raise ContractError("pdf_signature_invalid", "生成的PDF未通过本机验签，未交付。")
    return content, cert_bytes, {**verification, "certificate_fingerprint": fingerprint,
        "report_id": fact["id"], "report_content_hash": fact["content_hash"]}


def sign_delivery_manifest(store, content):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    path, _, certificate, _ = _identity(store)
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    signature = key.sign(content, padding.PKCS1v15(), hashes.SHA256())
    x509.load_pem_x509_certificate(certificate).public_key().verify(
        signature, content, padding.PKCS1v15(), hashes.SHA256())
    return signature
