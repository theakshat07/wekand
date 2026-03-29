/**
 * WhatsApp Cloud API (Meta Graph) — template messages after **event registration** (ticket booked).
 *
 * Env (optional; if token or phone number id is missing, sends are skipped):
 *   WHATSAPP_CLOUD_ACCESS_TOKEN   — System User / permanent token
 *   WHATSAPP_CLOUD_PHONE_NUMBER_ID — Phone number ID (WhatsApp → API Setup)
 *   WHATSAPP_GRAPH_API_VERSION    — default v22.0
 *   WHATSAPP_REGISTRATION_TEMPLATE_NAME — default test_template (must match approved template)
 *   WHATSAPP_TEMPLATE_LANGUAGE    — default en_US
 *   APP_NAME                        — default Vybeme
 *   WHATSAPP_TEMPLATE_SUPPORT_LABEL — default Support
 *
 * Template body should define **5** text variables in this order:
 *   1 — Attendee first name / display name
 *   2 — Ticket reference (ticket_number)
 *   3 — Event title
 *   4 — App name
 *   5 — Support label
 */

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || 'v22.0';

function toWhatsAppRecipientDigits(phone_number) {
  const digits = String(phone_number || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

function truncate(s, max) {
  const t = String(s || '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Notify the registrant on WhatsApp (non-blocking callers should use setImmediate).
 *
 * @param {object} params
 * @param {{ phone_number: string, name?: string }} params.user
 * @param {string} [params.planTitle] — event title
 * @param {string} [params.ticketNumber] — human-readable ticket number
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string }>}
 */
async function sendEventRegistrationWhatsApp({ user, planTitle, ticketNumber }) {
  const token = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return { ok: false, skipped: true };
  }

  if (!user || !user.phone_number) {
    console.warn('[WhatsApp] Skipping event registration message: no user phone');
    return { ok: false, skipped: true };
  }

  const to = toWhatsAppRecipientDigits(user.phone_number);
  if (!to || to.length < 10) {
    console.warn('[WhatsApp] Skipping event registration message: invalid phone');
    return { ok: false, skipped: true };
  }

  const templateName =
    process.env.WHATSAPP_REGISTRATION_TEMPLATE_NAME || 'test_template';
  const languageCode = process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US';

  const displayName = truncate((user.name && String(user.name).trim()) || 'Friend', 60);
  const ticketRef = truncate(ticketNumber || '—', 32);
  const eventTitle = truncate(planTitle || 'Event', 200);
  const appName = truncate(process.env.APP_NAME || 'Vybeme', 40);
  const supportLabel = truncate(
    process.env.WHATSAPP_TEMPLATE_SUPPORT_LABEL || 'Support',
    40
  );

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: displayName },
            { type: 'text', text: ticketRef },
            { type: 'text', text: eventTitle },
            { type: 'text', text: appName },
            { type: 'text', text: supportLabel },
          ],
        },
      ],
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        '[WhatsApp] Event registration template failed:',
        res.status,
        JSON.stringify(data)
      );
      return { ok: false, error: data?.error?.message || res.statusText };
    }
    return { ok: true };
  } catch (err) {
    console.error('[WhatsApp] Request error:', err.message || err);
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = {
  sendEventRegistrationWhatsApp,
  toWhatsAppRecipientDigits,
};
