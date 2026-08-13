/**
 * Outbound email.
 *
 * With SMTP configured (SMTP_HOST etc.) mail is delivered for real. Without it,
 * the transport falls back to writing the message to the server log so the
 * sign-in flow still works during setup and development — the passcode is never
 * returned through the API in either case.
 */
import nodemailer from 'nodemailer';
import { config } from './config.js';

let transport = null;
let transportKind = 'console';

if (config.smtp.host) {
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  transportKind = 'smtp';
} else {
  console.warn(
    '[mail] SMTP is not configured (SMTP_HOST unset). Sign-in passcodes will be printed to ' +
      'this log instead of emailed. Configure SMTP before letting subscribers in.',
  );
}

export function mailerStatus() {
  return { kind: transportKind, from: config.smtp.from, configured: transportKind === 'smtp' };
}

/**
 * Send a message. Never throws: a mail failure must not leak into the HTTP
 * response, because doing so would reveal whether an address exists.
 */
export async function sendMail({ to, subject, text, html }) {
  if (transportKind === 'console') {
    console.log(
      `\n[mail] ---------------------------------------------\n` +
        `[mail] To:      ${to}\n` +
        `[mail] Subject: ${subject}\n` +
        `[mail]\n${text.split('\n').map((l) => `[mail]   ${l}`).join('\n')}\n` +
        `[mail] ---------------------------------------------\n`,
    );
    return { delivered: false, logged: true };
  }

  try {
    await transport.sendMail({ from: config.smtp.from, to, subject, text, html });
    return { delivered: true };
  } catch (error) {
    console.error(`[mail] failed to send to ${to}:`, error.message);
    return { delivered: false, error: error.message };
  }
}

const shell = (title, body) => `<!doctype html>
<html><body style="margin:0;background:#f4f6fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e3e8f2">
    <div style="background:linear-gradient(135deg,#0e7490,#6d28d9);padding:20px 26px;color:#fff">
      <div style="font-size:17px;font-weight:700;letter-spacing:-.2px">Timely Regulatory</div>
      <div style="font-size:12px;opacity:.85;margin-top:2px">Live update from every health authority</div>
    </div>
    <div style="padding:26px;color:#1f2937;font-size:14.5px;line-height:1.6">
      <h1 style="margin:0 0 14px;font-size:19px;color:#111827">${title}</h1>
      ${body}
    </div>
    <div style="padding:16px 26px;border-top:1px solid #eef2f8;color:#8895ab;font-size:11.5px">
      Sent by Timely Regulatory. If you did not expect this email you can ignore it.
    </div>
  </div>
</body></html>`;

export function sendLoginCode({ to, name, code, minutes }) {
  const text =
    `Hello ${name},\n\n` +
    `Your Timely Regulatory sign-in passcode is: ${code}\n\n` +
    `It expires in ${minutes} minutes and can be used once.\n\n` +
    `If you did not try to sign in, change your password immediately.`;

  return sendMail({
    to,
    subject: `${code} is your Timely Regulatory passcode`,
    text,
    html: shell(
      'Your sign-in passcode',
      `<p>Hello ${escapeHtml(name)},</p>
       <p>Use this passcode to finish signing in:</p>
       <div style="font-size:31px;font-weight:700;letter-spacing:7px;text-align:center;
                   background:#f1f5fb;border:1px solid #e0e7f2;border-radius:11px;
                   padding:16px;margin:18px 0;color:#0f172a">${escapeHtml(code)}</div>
       <p style="color:#64748b;font-size:13px">Expires in ${minutes} minutes. Single use.</p>
       <p style="color:#64748b;font-size:13px">If you did not try to sign in, change your
       password immediately.</p>`,
    ),
  });
}

export function sendPasswordReset({ to, name, url, minutes }) {
  const text =
    `Hello ${name},\n\n` +
    `Reset your Timely Regulatory password using this link:\n${url}\n\n` +
    `The link expires in ${minutes} minutes and can be used once.\n\n` +
    `If you did not request this, no action is needed.`;

  return sendMail({
    to,
    subject: 'Reset your Timely Regulatory password',
    text,
    html: shell(
      'Reset your password',
      `<p>Hello ${escapeHtml(name)},</p>
       <p>Click below to choose a new password.</p>
       <p style="text-align:center;margin:22px 0">
         <a href="${escapeHtml(url)}"
            style="display:inline-block;background:#0e7490;color:#fff;text-decoration:none;
                   padding:12px 22px;border-radius:9px;font-weight:600">Reset password</a>
       </p>
       <p style="color:#64748b;font-size:12.5px;word-break:break-all">${escapeHtml(url)}</p>
       <p style="color:#64748b;font-size:13px">Expires in ${minutes} minutes. Single use.</p>`,
    ),
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
