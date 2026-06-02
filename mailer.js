/**
 * Cliente SMTP mínimo para enviar emails desde el backend.
 *
 * Pensado para Gmail con contraseña de aplicación (TLS implícito 465, AUTH
 * PLAIN). Sin dependencias externas: usa `node:tls` directamente. Mantiene
 * la firma simple porque solo se usa para emails transaccionales (reset de
 * contraseña, etc.).
 *
 * Variables de entorno:
 *   GMAIL_USER          - dirección remitente (ej. cuadrado.mario@aromasdete.com)
 *   GMAIL_APP_PASSWORD  - contraseña de aplicación de Gmail (16 caracteres)
 */
import { connect as tlsConnect } from 'node:tls';

const SMTP_HOST = process.env.GMAIL_SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.GMAIL_SMTP_PORT) || 465;

function quoteHeader(s) {
  // RFC 5322: cabeceras con caracteres no-ASCII se codifican como Q-encoded UTF-8.
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const b64 = Buffer.from(s, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

function buildMessage({ from, to, subject, text }) {
  const date = new Date().toUTCString();
  const messageId = `<${Math.random().toString(36).slice(2)}.${Date.now()}@aromas-app-backend>`;
  const headers = [
    `From: ${quoteHeader(from)}`,
    `To: ${to}`,
    `Subject: ${quoteHeader(subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  // SMTP exige CRLF entre líneas y que las que empiezan por "." se escapen
  // duplicándolas ("dot stuffing").
  const body = text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return headers.join('\r\n') + '\r\n\r\n' + body + '\r\n.';
}

/**
 * Envía un email de texto plano vía Gmail SMTP. Devuelve la promesa que
 * resuelve cuando el servidor acepta el mensaje (250 tras DATA). Lanza si
 * algún comando falla.
 */
export function sendEmail({ to, subject, text, from }) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    return Promise.reject(new Error('gmail_credentials_missing'));
  }
  const fromAddr = from || user;
  const msg = buildMessage({ from: fromAddr, to, subject, text });

  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
    let buffer = '';
    const steps = buildConversation(user, pass, fromAddr, to, msg, resolve, reject, socket);
    let step = steps.shift();

    socket.setEncoding('utf8');
    socket.setTimeout(20000, () => {
      socket.destroy(new Error('smtp_timeout'));
    });
    socket.on('error', (err) => reject(err));
    socket.on('data', (chunk) => {
      buffer += chunk;
      // Una respuesta SMTP puede ser multi-línea: las intermedias acaban en
      // "<code>-..." y la final en "<code> ...". Procesamos solo cuando
      // tenemos una respuesta completa.
      while (true) {
        const end = findResponseEnd(buffer);
        if (end < 0) break;
        const reply = buffer.slice(0, end);
        buffer = buffer.slice(end);
        const code = Number(reply.slice(0, 3));
        try {
          if (!step) return;
          const next = step(code, reply);
          if (next === 'done') {
            socket.end();
            resolve({ ok: true });
            return;
          }
          step = steps.shift();
        } catch (err) {
          socket.destroy();
          reject(err);
          return;
        }
      }
    });
  });
}

/** Localiza el final de una respuesta SMTP (línea que empieza por "NNN " sin guion). */
function findResponseEnd(buf) {
  let idx = 0;
  while (true) {
    const newline = buf.indexOf('\r\n', idx);
    if (newline < 0) return -1;
    const line = buf.slice(idx, newline);
    if (line.length >= 4 && line[3] === ' ') return newline + 2;
    idx = newline + 2;
  }
}

function buildConversation(user, pass, from, to, msg, resolve, reject, socket) {
  let dataMode = false;
  return [
    // Greeting
    (code) => {
      if (code !== 220) throw new Error('smtp_unexpected_' + code);
      socket.write('EHLO aromas-app-backend\r\n');
    },
    // EHLO response
    (code) => {
      if (code !== 250) throw new Error('smtp_ehlo_' + code);
      const auth = Buffer.from(`\0${user}\0${pass}`).toString('base64');
      socket.write(`AUTH PLAIN ${auth}\r\n`);
    },
    // AUTH
    (code) => {
      if (code !== 235) throw new Error('smtp_auth_' + code);
      socket.write(`MAIL FROM:<${from}>\r\n`);
    },
    (code) => {
      if (code !== 250) throw new Error('smtp_mailfrom_' + code);
      socket.write(`RCPT TO:<${to}>\r\n`);
    },
    (code) => {
      if (code !== 250 && code !== 251) throw new Error('smtp_rcpt_' + code);
      socket.write('DATA\r\n');
    },
    (code) => {
      if (code !== 354) throw new Error('smtp_data_' + code);
      socket.write(msg + '\r\n');
      dataMode = true;
    },
    (code) => {
      if (code !== 250) throw new Error('smtp_send_' + code);
      socket.write('QUIT\r\n');
      return 'done';
    },
  ];
}
