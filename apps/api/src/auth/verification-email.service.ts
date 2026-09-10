import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class VerificationEmailService {
  private readonly logger = new Logger(VerificationEmailService.name);

  constructor(private readonly config: ConfigService) {}

  async sendOwnerVerification(input: {
    email: string;
    firstName: string;
    code: string;
  }): Promise<void> {
    const webUrl = this.webUrl();
    await this.deliver({
      to: input.email,
      subject: "Verify your PharmaCeylon account",
      consoleLine: `Owner verification code for ${input.email}: ${input.code}`,
      label: "Verification",
      text:
        `Hi ${input.firstName},\n\nYour PharmaCeylon verification code is ${input.code}.\n\n` +
        `Enter it at ${webUrl}/verify-email. This code expires soon. If you did not request it, ignore this email.`,
      html:
        `<p>Hi ${escapeHtml(input.firstName)},</p>` +
        "<p>Use this verification code to continue setting up your pharmacy:</p>" +
        `<p style="font-size:32px;font-weight:700;letter-spacing:8px">${input.code}</p>` +
        `<p>Enter it at <a href="${webUrl}/verify-email">PharmaCeylon</a>. This code expires soon.</p>` +
        "<p>If you did not request it, ignore this email.</p>",
    });
  }

  async sendStaffInvitation(input: {
    email: string;
    fullName: string;
    pharmacyName: string;
    invitedByName: string;
    token: string;
  }): Promise<void> {
    const invitationUrl = `${this.webUrl()}/invite/${encodeURIComponent(input.token)}`;
    await this.deliver({
      to: input.email,
      subject: `You’re invited to ${input.pharmacyName} on PharmaCeylon`,
      consoleLine: `Staff invitation for ${input.email}: ${invitationUrl}`,
      label: "Invitation",
      text:
        `Hi ${input.fullName},\n\n${input.invitedByName} invited you to join ${input.pharmacyName} on PharmaCeylon.\n\n` +
        `Accept your invitation: ${invitationUrl}\n\nThis invitation expires in 7 days.`,
      html:
        `<p>Hi ${escapeHtml(input.fullName)},</p>` +
        `<p>${escapeHtml(input.invitedByName)} invited you to join <strong>${escapeHtml(input.pharmacyName)}</strong> on PharmaCeylon.</p>` +
        `<p><a href="${invitationUrl}" style="display:inline-block;padding:12px 20px;background:#0d9488;color:#fff;text-decoration:none;border-radius:8px">Accept invitation</a></p>` +
        "<p>This invitation expires in 7 days.</p>",
    });
  }

  /** Password recovery. The link is the only credential, so the copy deliberately
   *  tells a recipient who did not request it that no action is needed — their
   *  password is unchanged until the link is actually used. */
  async sendPasswordReset(input: {
    email: string;
    fullName: string;
    token: string;
    expiresInMinutes: number;
  }): Promise<void> {
    const resetUrl = `${this.webUrl()}/reset-password/${encodeURIComponent(input.token)}`;
    const window = `${input.expiresInMinutes} minutes`;
    await this.deliver({
      to: input.email,
      subject: "Reset your PharmaCeylon password",
      consoleLine: `Password reset for ${input.email}: ${resetUrl}`,
      label: "Password reset",
      text:
        `Hi ${input.fullName},\n\nWe received a request to reset your PharmaCeylon password.\n\n` +
        `Choose a new password: ${resetUrl}\n\nThis link works once and expires in ${window}.\n\n` +
        "If you did not request this, you can ignore this email — your password has not changed.",
      html:
        `<p>Hi ${escapeHtml(input.fullName)},</p>` +
        "<p>We received a request to reset your PharmaCeylon password.</p>" +
        `<p><a href="${resetUrl}" style="display:inline-block;padding:12px 20px;background:#0d9488;color:#fff;text-decoration:none;border-radius:8px">Choose a new password</a></p>` +
        `<p>This link works once and expires in ${window}.</p>` +
        "<p>If you did not request this, you can ignore this email — your password has not changed.</p>",
    });
  }

  private webUrl(): string {
    return (
      this.config.get<string>("PUBLIC_WEB_URL") ?? "http://localhost:3000"
    ).replace(/\/$/, "");
  }

  /** One delivery path for every transactional email. In `console` mode it logs
   *  (and refuses outright under NODE_ENV=production, so a misconfigured deploy
   *  fails loudly instead of silently dropping credentials). */
  private async deliver(input: {
    to: string;
    subject: string;
    text: string;
    html: string;
    consoleLine: string;
    label: string;
  }): Promise<void> {
    const mode = (
      this.config.get<string>("EMAIL_DELIVERY_MODE") ?? "console"
    ).toLowerCase();

    if (mode === "console") {
      if (
        (this.config.get<string>("NODE_ENV") ?? "development") === "production"
      ) {
        throw new ServiceUnavailableException(
          "Email delivery is not configured",
        );
      }
      this.logger.log(input.consoleLine);
      return;
    }

    if (mode !== "resend") {
      throw new ServiceUnavailableException("Unsupported email delivery mode");
    }

    const apiKey = this.config.get<string>("RESEND_API_KEY");
    const from = this.config.get<string>("EMAIL_FROM");
    if (!apiKey || !from) {
      throw new ServiceUnavailableException("Email delivery is not configured");
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
      }),
    });

    if (!response.ok) {
      this.logger.error(
        `${input.label} email provider returned HTTP ${response.status}`,
      );
      throw new ServiceUnavailableException(
        `${input.label} email could not be sent`,
      );
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const replacements: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return replacements[char] ?? char;
  });
}
