import nodemailer from 'nodemailer';

// Sends real email through SMTP when SMTP_HOST is configured (Mailpit in Docker
// Compose, or a provider such as Gmail/SES/SendGrid); otherwise logs the message.
export function createMailer(env = process.env) {
  const from = env.MAIL_FROM || 'StayDesk Hotel <no-reply@staydesk.local>';
  if (!env.SMTP_HOST) {
    return {
      transport: 'log',
      async sendEmail({ to, subject, text }) {
        console.info(JSON.stringify({ type: 'test-email', to, subject, text }));
      }
    };
  }

  const port = Number(env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
  });

  return {
    transport: 'smtp',
    async sendEmail({ to, subject, text, html }) {
      const info = await transporter.sendMail({ from, to, subject, text, html });
      console.info(JSON.stringify({ type: 'email-sent', to, subject, messageId: info.messageId }));
    }
  };
}

export async function sendSms({ to, text }) {
  console.info(JSON.stringify({
    type: 'test-sms',
    to,
    text
  }));
}
