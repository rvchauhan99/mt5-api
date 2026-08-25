import nodemailer from "nodemailer";
import { env } from "../../config/env";
import { logger } from "../logger";

// Create a transporter with Brevo SMTP configuration
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false, // Use TLS - false for port 587
  auth: {
    user: env.brevoUser, // Your Brevo login
    pass: env.brevoMasterKey, // Your Brevo master key
  },
});

interface Attachment {
  filename: string;
  path?: string;
  content?: string | Buffer;
}

/**
 * Generic email sending function
 * @param to - Recipient email address
 * @param subject - Email subject
 * @param text - Plain text body
 * @param html - HTML body (optional)
 * @param attachments - Array of attachment objects (optional) [{ filename, path }]
 * @returns Email info or throws error
 */
export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  html: string | null = null,
  attachments: Attachment[] = []
) {
  try {
    // Skip if credentials not set fully
    if (!env.brevoUser || !env.brevoMasterKey) {
      logger.info({ to, subject, text }, "No email credentials configured, simulated sending email");
      return { success: true, message: "Email logged (simulated)", messageId: "simulated" };
    }

    const mailOptions = {
      from: `'CrickiERP Admin' <${env.brevoFrom}>`,
      to,
      subject,
      text,
      html: html ?? undefined,
      attachments,
    };

    const info = await transporter.sendMail(mailOptions);
    logger.info({ messageId: info.messageId }, "Email sent successfully");
    return info;
  } catch (error) {
    logger.error({ err: error }, "Error sending email");
    throw error;
  }
}

/**
 * Generate HTML template for password reset email
 * @param otp - 6-digit OTP code
 * @param userName - User's name (optional)
 * @returns HTML email template
 */
export function generatePasswordResetEmailHTML(otp: string, userName: string = "User"): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f8f9fa;">
      <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
        <div style="text-align: center; margin-bottom: 30px;">
          <h2 style="color: #333; margin: 0; font-size: 24px;">Password Reset Request</h2>
        </div>
        
        <div style="margin-bottom: 25px;">
          <p style="color: #555; font-size: 16px; line-height: 1.6; margin: 0 0 15px 0;">
            Hello ${userName},
          </p>
          <p style="color: #555; font-size: 16px; line-height: 1.6; margin: 0 0 15px 0;">
            You have requested to reset your password. 
            Please use the following OTP (One-Time Password) to complete the password reset process:
          </p>
        </div>
        
        <div style="text-align: center; margin: 30px 0; padding: 20px; background-color: #f0f4f8; border-radius: 6px; border: 2px dashed #4a90e2;">
          <div style="font-size: 36px; font-weight: bold; color: #4a90e2; letter-spacing: 8px; font-family: 'Courier New', monospace;">
            ${otp}
          </div>
        </div>
        
        <div style="margin-bottom: 25px;">
          <p style="color: #555; font-size: 16px; line-height: 1.6; margin: 0 0 15px 0;">
            <strong>Important:</strong>
          </p>
          <ul style="color: #555; font-size: 14px; line-height: 1.8; margin: 0; padding-left: 20px;">
            <li>This OTP is valid for <strong>10 minutes</strong> only</li>
            <li>Do not share this OTP with anyone</li>
            <li>If you did not request this password reset, please ignore this email</li>
          </ul>
        </div>
        
        <div style="margin-top: 30px; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
          <p style="margin: 0; color: #856404; font-size: 13px; line-height: 1.6;">
            <strong>Security Notice:</strong> For your security, this OTP will expire in 10 minutes. 
            If you did not request a password reset, please contact your administrator immediately.
          </p>
        </div>
        
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
          <p style="color: #999; font-size: 12px; margin: 0; text-align: center;">
            This is an automated email. Please do not reply to this message.
          </p>
        </div>
      </div>
    </div>
  `;
}

/**
 * Send password reset OTP email
 * @param to - Recipient email address
 * @param otp - 6-digit OTP code
 * @param userName - User's name (optional)
 * @returns Email info
 */
export async function sendPasswordResetEmail(to: string, otp: string, userName: string = "User") {
  try {
    const subject = "Password Reset - CrickiERP";
    const text = `Your password reset OTP is: ${otp}. This OTP is valid for 10 minutes. If you did not request this, please ignore this email.`;
    const html = generatePasswordResetEmailHTML(otp, userName);

    return await sendEmail(to, subject, text, html);
  } catch (error) {
    logger.error({ err: error }, "Error sending password reset email");
    throw error;
  }
}
