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
    const webUrl = (
      this.config.get<string>("PUBLIC_WEB_URL") ?? "http://localhost:3000"
    ).replace(/\/$/, "");
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
      this.logger.log(
        `Owner verification code for ${input.email}: ${input.code}`,
      );
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

    const firstName = escapeHtml(input.firstName);
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.email],
        subject: "Verify your PharmaCeylon account",
        text:
          `Hi ${input.firstName},\n\nYour PharmaCeylon verification code is ${input.code}.\n\n` +
          `Enter it at ${webUrl}/verify-email. This code expires soon. If you did not request it, ignore this email.`,
        html:
          `<p>Hi ${firstName},</p>` +
          "<p>Use this verification code to continue setting up your pharmacy:</p>" +
          `<p style="font-size:32px;font-weight:700;letter-spacing:8px">${input.code}</p>` +
          `<p>Enter it at <a href="${webUrl}/verify-email">PharmaCeylon</a>. This code expires soon.</p>` +
          "<p>If you did not request it, ignore this email.</p>",
      }),
    });

    if (!response.ok) {
      this.logger.error(
        `Verification email provider returned HTTP ${response.status}`,
      );
      throw new ServiceUnavailableException(
        "Verification email could not be sent",
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
