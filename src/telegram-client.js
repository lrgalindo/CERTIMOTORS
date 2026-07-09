import axios from 'axios';
import { logger } from './logger.js';

export async function enviarMensajeTelegram(botToken, chatId, texto) {
  if (!botToken) return;
  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: texto,
      parse_mode: 'HTML',
    });
    logger.success(`Message sent to Telegram (${chatId})`);
  } catch (error) {
    logger.error('Error sending to Telegram', { error: error.message });
  }
}

export async function registrarWebhookTelegram(botToken, webhookUrl, nombre, secretToken = undefined) {
  if (!botToken) return;

  logger.info(`Registering ${nombre} Telegram webhook: ${webhookUrl}`);

  try {
    const response = await axios.post(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      url: webhookUrl,
      ...(secretToken ? { secret_token: secretToken } : {}),
    });

    if (response.data.ok) {
      logger.success(`${nombre} Telegram webhook registered`);
    } else {
      logger.error(`${nombre} webhook registration error`, { error: response.data.description });
    }
  } catch (error) {
    logger.error(`${nombre} Telegram setup error`, { error: error.message });
  }
}
