import Discord from 'discord.js'
import dateformat from 'dateformat'
import signale from 'signale'
import distanceInWords from 'date-fns/distance_in_words_strict'
import isAfter from 'date-fns/is_after'
import { CalendarFeed, reminderIntervals } from './calendar'
import {
  welcomeMessage,
  eventMessage,
  serverMessage,
  scrapeServerPage,
  ServerInformation
} from './lib/messages'
import { Routine, Routinable } from './routine'

type BotAction = (ctx: Bot, msg: Discord.Message, args: string[]) => Promise<string>

/**
 * Wrapper class for the Discord SDK and handling custom commands
 * @export
 * @class Bot
 * @implements Routinable
 * @property {string} GUILD_NAME
 * @property {string} LOG_CHANNEL
 * @property {string} MAIN_CHANNEL
 * @property {string} ARMA_CHANNEL
 * @property {string} BMS_CHANNEL
 * @property {string} ARMA_PLAYER_ROLE
 * @property {string} BMS_PLAYER_ROLE
 * @property {Discord.Guild?} _guild
 * @property {CalendarFeed} _calendar
 * @property {Discord.Client} _client
 * @property {Map<string, BotAction>} _commands
 * @property {Routine<void>?} _calendarRoutine
 * @property {ServerInformation?} _currentMission
 */
export class Bot implements Routinable {
  // Static and readonly variables for the Bot class
  private static readonly GUILD_ID: string = process.env.DISCORD_SERVER_ID!
  private static readonly LOG_CHANNEL: string = process.env.DISCORD_LOG_CHANNEL!
  private static readonly MAIN_CHANNEL: string = process.env.DISCORD_MAIN_CHANNEL!
  private static readonly ARMA_CHANNEL: string = process.env.DISCORD_ARMA_CHANNEL!
  private static readonly BMS_CHANNEL: string = process.env.DISCORD_BMS_CHANNEL!
  private static readonly ARMA_PLAYER_ROLE: string = process.env.DISCORD_ARMA_PLAYER_ROLE!
  private static readonly BMS_PLAYER_ROLE: string = process.env.DISCORD_BMS_PLAYER_ROLE!
  private static readonly MIN_PLAYER_ALERT: number = parseInt(process.env.NUM_PLAYER_FOR_ALERT!)

  // Bot instance variables
  private _guild?: Discord.Guild
  private _calendar: CalendarFeed
  private _client: Discord.Client
  private _commands: Map<string, BotAction> = new Map()
  private _calendarRoutine?: Routine<void>
  private _serverRoutine?: Routine<string>
  private _currentMission?: ServerInformation

  /**
   * Creates an instance of Bot
   * @memberof Bot
   */
  constructor() {
    this._client = new Discord.Client()
    this._client.on('ready', () => {
      signale.fav(`Logged in as ${this._client.user.tag}`)
      this._guild = this._client.guilds.find(g => g.id === Bot.GUILD_ID)
    })
    this._client.on('disconnect', () => signale.warn('Going offline...'))
    this._client.on('reconnecting', () => signale.warn('Attempting to reconnect...'))
    this._client.on('message', this._onMessage)
    this._client.on('guildMemberAdd', this._onNewMember)

    this._calendar = new CalendarFeed(
      'http://forums.unitedoperations.net/index.php/rss/calendar/1-community-calendar/'
    )
  }

  /**
   * Wrapper function for the Discord client's login function
   * to initialize and start the chat bot in the Discord server
   * @async
   * @param token {string}
   * @returns {Promise<string>}
   * @memberof Bot
   */
  async start(token: string): Promise<string> {
    try {
      // Initial calendar feed pull, handled by routine in CalendarFeed instance after
      await this._calendar.pull()

      // Create a new routine to check for notifications on events on an interval
      this._calendarRoutine = new Routine<void>(
        async () => await this._notifyOfEvents(),
        [],
        1 * 60 * 1000 // Minutes to millisecond
      )

      // Create a new routine to check for new missions being loaded on A3 server
      this._serverRoutine = new Routine<string>(
        async url => await this._notifyOfNewMission(url),
        ['http://www.unitedoperations.net/tools/uosim/'],
        5 * 60 * 1000
      )
    } catch (e) {
      signale.error(`START: ${e.message}`)
    }

    // Login with the Discord client
    return this._client.login(token)
  }

  /**
   * Ends all routines running on intervals
   * @memberof Bot
   */
  clear() {
    ;(this._calendarRoutine as Routine<any>).terminate()
    ;(this._serverRoutine as Routine<any>).terminate()
  }

  /**
   * Adds a new command action to the map under a key
   * that is the command string for application to the
   * _onMessage handler at start
   * @param {string} cmd
   * @param {(Bot, Discord.Message, string[]) => Promise<string>} action
   * @memberof Bot
   */
  addCommand(cmd: string, action: BotAction) {
    this._commands.set(cmd, action)
  }

  /**
   * Performs a scrape of the A3 primary's server information URL argued
   * and if there is an update since the last run, notify to A3 player group
   * @private
   * @async
   * @param {string} url
   * @memberof Bot
   */
  private async _notifyOfNewMission(url: string) {
    try {
      let info: ServerInformation | null = await scrapeServerPage(url)

      // Set default information if error or none found
      if (!info) {
        info = {
          mission: 'None',
          description: 'Unknown',
          players: '0/64',
          island: 'Unknown',
          author: 'Unknown'
        }
      }

      // If the new data is different from previous
      // replace the current data and send the notification
      const players: number = parseInt(info.players.split('/')[0])
      if (
        (!this._currentMission || info.mission !== this._currentMission.mission) &&
        info.mission !== 'None' &&
        players >= Bot.MIN_PLAYER_ALERT
      ) {
        this._currentMission = info
        const msg = serverMessage(info) as Discord.RichEmbed
        const channel = this._guild!.channels.find(
          c => c.id === Bot.ARMA_CHANNEL
        ) as Discord.TextChannel
        await channel.send(`_**NEW MISSION 🎉**_`, { embed: msg })
      }
    } catch (e) {
      signale.error(`NEW_MISSION: ${e.message}`)
    }
  }

  /**
   * Pulls updates from the RSS event feed and send reminds if necessary
   * after comparing the start time of the event and the current time
   * @private
   * @async
   * @memberof Bot
   */
  private async _notifyOfEvents() {
    const now = new Date()
    this._calendar.events.forEach(async e => {
      // Get the time difference between now and the event date
      const [isoEvent, isoNow] = [new Date(e.date.toISOString()), new Date(now.toISOString())]
      const diff = distanceInWords(isoEvent, isoNow)

      // Check if the time difference matches a configured time reminder
      if (
        reminderIntervals.some(r => r === diff) &&
        !e.reminders.get(diff) &&
        isAfter(isoEvent, isoNow)
      ) {
        signale.star(`Sending notification for event: ${e.title}`)

        // Ensure it won't send this same reminder type again
        e.reminders.set(diff, true)

        // If hour difference is within the remind window, send message to
        // all users of the designated group with the reminder in the main channel
        const msg = eventMessage(e, diff) as Discord.RichEmbed

        try {
          // Determine the channel that the message should be send to and who to tag
          let channel: Discord.TextChannel
          let role: Discord.Role | null
          switch (e.group) {
            // ArmA 3 event reminder
            case 'UOA3':
              role = this._guild!.roles.find(r => r.name === Bot.ARMA_PLAYER_ROLE)
              channel = this._guild!.channels.find(
                c => c.id === Bot.ARMA_CHANNEL
              ) as Discord.TextChannel
              break
            // BMS event reminder
            case 'UOAF':
              role = this._guild!.roles.find(r => r.name === Bot.BMS_PLAYER_ROLE)
              channel = this._guild!.channels.find(
                c => c.id === Bot.BMS_CHANNEL
              ) as Discord.TextChannel
              break
            // UOTC course reminder
            case 'UOTC':
              role = null
              channel = this._guild!.channels.find(
                c => c.id === Bot.ARMA_CHANNEL
              ) as Discord.TextChannel
              break
            // Unknown event type reminder
            default:
              role = null
              channel = this._guild!.channels.find(
                c => c.id === Bot.MAIN_CHANNEL
              ) as Discord.TextChannel
          }

          // Dispatch event reminder to correct group and channel
          await channel.send(role ? role.toString() : '', { embed: msg })
        } catch (e) {
          signale.error(`EVENT ${e.name}: ${e.message}`)
        }
      }
    })
  }

  /**
   * Handler for when a new user joins the Discord server,
   * it generates a welcome message and send it through a
   * private message to the new user
   * @private
   * @async
   * @param {Discord.GuildMember} member
   * @memberof Bot
   */
  private _onNewMember = async (member: Discord.GuildMember) => {
    const username: string = member.user.username
    try {
      await member.send({ embed: welcomeMessage(username) })
    } catch (e) {
      signale.error(`NEW_USER ${username}: ${e.message}`)
    }
  }

  /**
   * Handler for when a new message is received to the bot
   * and it determines the current way to react based on the
   * command found. If the message it determined now to be a valid
   * command or was a message create by the bot, nothing happens
   * @private
   * @async
   * @param {Discord.Message} msg
   * @memberof Bot
   */
  private _onMessage = async (msg: Discord.Message) => {
    // Skip message if came from bot
    if (msg.author.bot || !msg.guild) return

    // Get the command and its arguments from received message
    const [cmd, ...args] = msg.content.split(' ')
    const cmdKey = cmd.slice(1)

    // Check if the message actually is a command (starts with '!')
    if (cmd.startsWith('!')) {
      // Look for a handler function is the map that matches the command
      const fn = this._commands.get(cmdKey)
      if (fn) {
        try {
          // Delete the original command, run the handler and log the response
          await msg.delete()

          const output = await fn(this, msg, args)
          await this._log(msg.author.tag, [cmd, ...args].join(' '), output)

          if (cmd === '!shutdown' && output === 'shutdown successful') process.exit(0)
        } catch (e) {
          signale.error(`COMMAND (${cmd}) : ${e}`)
        }
      } else {
        await msg.delete()
        signale.error(`No command function found for '!${cmdKey}'`)
      }
    }
  }

  /**
   * Logs all commands run through the bot to the designated logging
   * channel on the Discord server with the essential date and timestamp
   * @private
   * @async
   * @param {string} tag
   * @param {string} cmd
   * @param {string} output
   * @returns {Promise<any>}
   * @memberof Bot
   */
  private _log(tag: string, cmd: string, output: string): Promise<any> {
    const timestamp = dateformat(new Date(), 'UTC:HH:MM:ss|yy-mm-dd')
    const logChannel = this._guild!.channels.find(
      c => c.id === Bot.LOG_CHANNEL
    ) as Discord.TextChannel
    return logChannel.send(
      `${tag} ran "${cmd.replace('@&', '')}" at time ${timestamp}: "${output}"`
    )
  }
}
