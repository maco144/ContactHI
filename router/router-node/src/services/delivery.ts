import { config } from '../config';
import { ChiEnvelope } from '../middleware/validate';
import { HumanPreferences } from './registry';
import { writeToAgentInbox } from './spacetime';

export type Channel = 'push' | 'sms' | 'email' | 'webhook' | 'agent-inbox';

export interface DeliveryResult {
  success: boolean;
  channel: Channel;
  error?: string;
}

// ---------------------------------------------------------------------------
// FCM Push Notification
// ---------------------------------------------------------------------------

/**
 * Deliver via Firebase Cloud Messaging.
 * Requires recipient's FCM registration token to be stored in their preferences.
 */
export async function deliverPush(
  recipient_did: string,
  message: ChiEnvelope,
  fcm_token: string
): Promise<DeliveryResult> {
  if (!config.fcm_key) {
    return { success: false, channel: 'push', error: 'FCM_NOT_CONFIGURED' };
  }

  try {
    const { default: fetch } = await import('node-fetch');

    const body = {
      to: fcm_token,
      notification: {
        title: `CHI message (${message.intent})`,
        body: typeof message.payload === 'string'
          ? message.payload.slice(0, 200)
          : 'You have a new CHI message',
      },
      data: {
        chi_message_id: message.message_id,
        sender_did: message.sender_did,
        intent: message.intent,
      },
      priority: message.priority !== undefined && message.priority > 200 ? 'high' : 'normal',
    };

    const response = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `key=${config.fcm_key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = await response.text();
      return { success: false, channel: 'push', error: `FCM_HTTP_${response.status}: ${text}` };
    }

    const result = (await response.json()) as { success?: number; failure?: number };
    if (result.failure && result.failure > 0) {
      return { success: false, channel: 'push', error: 'FCM_SEND_FAILURE' };
    }

    return { success: true, channel: 'push' };
  } catch (err) {
    return { success: false, channel: 'push', error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// SMS via Twilio
// ---------------------------------------------------------------------------

export async function deliverSms(
  phone: string,
  message: ChiEnvelope
): Promise<DeliveryResult> {
  if (!config.twilio_sid || !config.twilio_token || !config.twilio_from) {
    return { success: false, channel: 'sms', error: 'TWILIO_NOT_CONFIGURED' };
  }

  const body = typeof message.payload === 'string'
    ? `[CHI] ${message.payload.slice(0, 140)}`
    : `[CHI] New message from ${message.sender_did} (${message.intent})`;

  try {
    const { default: fetch } = await import('node-fetch');

    const params = new URLSearchParams({
      From: config.twilio_from,
      To: phone,
      Body: body,
    });

    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio_sid}/Messages.json`;
    const credentials = Buffer.from(`${config.twilio_sid}:${config.twilio_token}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const text = await response.text();
      return { success: false, channel: 'sms', error: `TWILIO_HTTP_${response.status}: ${text}` };
    }

    return { success: true, channel: 'sms' };
  } catch (err) {
    return { success: false, channel: 'sms', error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Email via SMTP (nodemailer)
// ---------------------------------------------------------------------------

/**
 * Send email using SMTP.  Uses nodemailer if available; falls back to a raw
 * SMTP implementation note if the package is not installed.
 *
 * Note: nodemailer is intentionally left as an optional peer dependency to
 * keep the core package slim. Add it to package.json if you need email delivery.
 */
export async function deliverEmail(
  email: string,
  message: ChiEnvelope
): Promise<DeliveryResult> {
  if (!config.smtp_host || !config.smtp_user || !config.smtp_pass) {
    return { success: false, channel: 'email', error: 'SMTP_NOT_CONFIGURED' };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require('nodemailer');

    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: 587,
      secure: false,
      auth: {
        user: config.smtp_user,
        pass: config.smtp_pass,
      },
    });

    const textBody = typeof message.payload === 'string'
      ? message.payload
      : JSON.stringify(message.payload, null, 2);

    await transporter.sendMail({
      from: config.smtp_user,
      to: email,
      subject: `[CHI] ${message.intent} from ${message.sender_did}`,
      text: [
        `You have received a CHI message.`,
        ``,
        `From: ${message.sender_did} (${message.sender_type})`,
        `Intent: ${message.intent}`,
        `Message ID: ${message.message_id}`,
        ``,
        textBody,
      ].join('\n'),
    });

    return { success: true, channel: 'email' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find module 'nodemailer'")) {
      return { success: false, channel: 'email', error: 'NODEMAILER_NOT_INSTALLED' };
    }
    return { success: false, channel: 'email', error: msg };
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export async function deliverWebhook(
  webhookUrl: string,
  message: ChiEnvelope
): Promise<DeliveryResult> {
  try {
    const { default: fetch } = await import('node-fetch');

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chi-Message-ID': message.message_id,
        'X-Chi-Version': '1.0',
      },
      body: JSON.stringify({
        chi_version: '1.0',
        message_id: message.message_id,
        sender_did: message.sender_did,
        sender_type: message.sender_type,
        intent: message.intent,
        payload_type: message.payload_type,
        payload: message.payload,
        created_at: message.created_at,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return {
        success: false,
        channel: 'webhook',
        error: `WEBHOOK_HTTP_${response.status}`,
      };
    }

    return { success: true, channel: 'webhook' };
  } catch (err) {
    return { success: false, channel: 'webhook', error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Agent Inbox (SpacetimeDB)
// ---------------------------------------------------------------------------

/**
 * Writes the message directly to the recipient's agent inbox table in
 * SpacetimeDB. This is the preferred channel for agent-to-agent communication.
 */
export async function deliverAgentInbox(
  recipient_did: string,
  message: ChiEnvelope
): Promise<DeliveryResult> {
  try {
    await writeToAgentInbox(recipient_did, message);
    return { success: true, channel: 'agent-inbox' };
  } catch (err) {
    return { success: false, channel: 'agent-inbox', error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Attempt delivery over the given channels in priority order.
 * Returns the first successful result, or the last failure if all channels fail.
 *
 * @param channels   Ordered list of channels to try
 * @param prefs      Recipient's preference record (provides channel-specific tokens)
 * @param message    The CHI envelope to deliver
 */
export async function deliver(
  channels: Channel[],
  prefs: HumanPreferences | null,
  message: ChiEnvelope
): Promise<DeliveryResult> {
  let lastResult: DeliveryResult = {
    success: false,
    channel: 'agent-inbox',
    error: 'NO_CHANNELS',
  };

  // Resolve channel-specific endpoint data from preferences.
  // In a real deployment these come from the on-chain preference record.
  const channelEndpoints = extractEndpoints(prefs);

  for (const channel of channels) {
    let result: DeliveryResult;

    switch (channel) {
      case 'push': {
        const token = channelEndpoints.fcm_token;
        if (!token) {
          result = { success: false, channel: 'push', error: 'NO_FCM_TOKEN' };
          break;
        }
        result = await deliverPush(message.recipient_did, message, token);
        break;
      }

      case 'sms': {
        const phone = channelEndpoints.phone;
        if (!phone) {
          result = { success: false, channel: 'sms', error: 'NO_PHONE_NUMBER' };
          break;
        }
        result = await deliverSms(phone, message);
        break;
      }

      case 'email': {
        const email = channelEndpoints.email;
        if (!email) {
          result = { success: false, channel: 'email', error: 'NO_EMAIL_ADDRESS' };
          break;
        }
        result = await deliverEmail(email, message);
        break;
      }

      case 'webhook': {
        const webhookUrl = channelEndpoints.webhook_url;
        if (!webhookUrl) {
          result = { success: false, channel: 'webhook', error: 'NO_WEBHOOK_URL' };
          break;
        }
        result = await deliverWebhook(webhookUrl, message);
        break;
      }

      case 'agent-inbox':
        result = await deliverAgentInbox(message.recipient_did, message);
        break;

      default:
        result = { success: false, channel, error: 'UNKNOWN_CHANNEL' };
    }

    lastResult = result;

    if (result.success) {
      console.log(
        `[delivery] message_id=${message.message_id} delivered via channel=${channel}`
      );
      return result;
    }

    console.warn(
      `[delivery] message_id=${message.message_id} channel=${channel} failed: ${result.error}`
    );
  }

  return lastResult;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ChannelEndpoints {
  fcm_token?: string;
  phone?: string;
  email?: string;
  webhook_url?: string;
}

/**
 * Extract delivery endpoints from a HumanPreferences record.
 * The on-chain record stores these as extension fields; the exact schema
 * is defined by the CosmWasm preference registry contract.
 */
function extractEndpoints(prefs: HumanPreferences | null): ChannelEndpoints {
  if (!prefs) return {};
  // The prefs object may carry extension fields cast through unknown
  const ext = prefs as unknown as Record<string, string>;
  return {
    fcm_token: ext['fcm_token'],
    phone: ext['phone'],
    email: ext['email'],
    webhook_url: ext['webhook_url'],
  };
}
