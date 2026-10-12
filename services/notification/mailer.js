export async function sendEmail({ to, subject, text }) {
  console.info(JSON.stringify({
    type: 'test-email',
    to,
    subject,
    text
  }));
}