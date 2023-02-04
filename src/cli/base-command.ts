import { Command, Flags, Interfaces } from '@oclif/core';
import { ImmichApi } from '../api/client';

export type Flags<T extends typeof Command> = Interfaces.InferredFlags<typeof BaseCommand['baseFlags'] & T['flags']>;
export type Args<T extends typeof Command> = Interfaces.InferredArgs<T['args']>;

export abstract class BaseCommand<T extends typeof Command> extends Command {
  static baseFlags = {
    server: Flags.url({
      char: 's',
      summary: 'Server address (http://<your-ip>:2283/api or https://<your-domain>/api)',
      env: 'IMMICH_SERVER_ADDRESS',
      required: true,
      helpGroup: 'GLOBAL',
    }),
    key: Flags.string({
      char: 'k',
      summary: 'Immich API key',
      env: 'IMMICH_API_KEY',
      required: true,
      helpGroup: 'GLOBAL',
    }),
  };

  protected flags!: Flags<T>;
  protected args!: Args<T>;

  protected client!: ImmichApi;

  public async init(): Promise<void> {
    await super.init();

    try {
      const { args, flags } = await this.parse({
        flags: this.ctor.flags,
        baseFlags: (super.ctor as typeof BaseCommand).baseFlags,
        args: this.ctor.args,
        strict: this.ctor.strict,
      });

      this.flags = flags as Flags<T>;
      this.args = args as Args<T>;

      this.client = new ImmichApi(this.flags.server, this.flags.key);
    } catch {
      this.error("Failed to parse command's arguments and flags", {
        exit: 1,
        suggestions: ["Use --help to see the command's usage"],
      });
    }
  }
}
