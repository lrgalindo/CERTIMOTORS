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
