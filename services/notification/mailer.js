export async function sendEmail({ to, subject, text }) {
  console.info(JSON.stringify({
    type: 'test-email',
    to,
    subject,
    text
  }));
}

export async function sendSms({ to, text }) {
  console.info(JSON.stringify({
    type: 'test-sms',
    to,
    text
  }));
}
