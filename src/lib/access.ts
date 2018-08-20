import { Message } from 'discord.js'
import { BotAction } from '../bot'

type ActionPermissioner = (fn: BotAction) => BotAction

const permissionsError: string = 'invalid user permissions'

/**
 * Constant array of allow Discord server groups for people to join
 * @export
 */
export const allowedDiscordGroups: string[] = process.env.DISCORD_ALLOWED_GROUPS!.split(',')

/**
 * Array of roles allowed to run the admin only commands
 * @export
 */
export const adminGroups: string[] = process.env.ADMIN_ROLES!.split(',')

/**
 * Role permission wrappers for bot action functions using
 * the `permissioned` currying function
 * @exports
 */
export const admin: ActionPermissioner = permissioned(adminGroups)
export const regular: ActionPermissioner = permissioned(['Regulars'])

/**
 * Currying function to assign groups into different permissioned
 * controller for BotAction functions
 * @param {string[]} group
 * @returns {(BotAction) => BotAction}
 */
function permissioned(group: string[]): (fn: BotAction) => BotAction {
  return (fn: BotAction): BotAction => {
    return async (msg: Message, args: string[]): Promise<string> => {
      // Check if the calling user has permission to call command
      for (const g of group) {
        if (msg.member.roles.find(r => r.name === g) !== null) {
          return await fn(msg, args)
        }
      }

      // If they don't have admin permissions
      await msg.author.send(`You don't have permission to run this command!`)
      return permissionsError
    }
  }
}