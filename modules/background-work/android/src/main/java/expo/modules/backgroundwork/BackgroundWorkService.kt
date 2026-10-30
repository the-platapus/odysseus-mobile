package expo.modules.backgroundwork

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the app's process running while it downloads a model or generates a reply, and shows
 * that work as an ongoing notification.
 *
 * Without it, Android freezes the app soon after the screen turns off: the download's
 * connection drops and generation stops. The JS side keeps doing the work itself (the download
 * through expo-file-system, generation through llama.rn); this service only makes the process
 * a foreground service and holds a partial wake lock so that work can continue.
 *
 * Each kind of work ("download", "generation") has its own notification. The first active one
 * is the service's foreground notification; on Android 16 both ask to be shown as Live Updates
 * (status bar chips), Android's counterpart to iOS Live Activities.
 */
class BackgroundWorkService : Service() {

  data class Work(val kind: String, var title: String, var text: String, var progress: Int?)

  companion object {
    private const val TAG = "BackgroundWork"
    private const val CHANNEL_ONGOING = "background_work"
    private const val CHANNEL_DONE = "background_work_done"
    // Long enough for a large download; stops a forgotten wake lock from draining the battery.
    private const val WAKE_LOCK_TIMEOUT_MS = 6L * 60 * 60 * 1000

    private val lock = Any()
    private val work = LinkedHashMap<String, Work>()
    @Volatile private var running: BackgroundWorkService? = null
    @Volatile private var starting = false

    private fun notificationId(kind: String) = if (kind == "download") 4101 else 4102
    private fun doneNotificationId(kind: String) = if (kind == "download") 4201 else 4202

    fun start(context: Context, kind: String, title: String, text: String, progress: Int?) {
      ensureChannels(context)
      synchronized(lock) { work[kind] = Work(kind, title, text, progress?.coerceIn(0, 100)) }
      val service = running
      if (service != null) {
        service.refresh()
      } else if (!starting) {
        starting = true
        try {
          // Allowed because the user just started this work from the app, which is in the foreground.
          ContextCompat.startForegroundService(context, Intent(context, BackgroundWorkService::class.java))
        } catch (e: Exception) {
          starting = false
          Log.w(TAG, "Could not start the foreground service", e)
        }
      }
    }

    fun update(context: Context, kind: String, title: String, text: String, progress: Int?) {
      val updated = synchronized(lock) {
        work[kind]?.also {
          it.title = title
          it.text = text
          it.progress = progress?.coerceIn(0, 100)
        }?.copy()
      } ?: return
      notify(context, notificationId(kind), build(context, updated))
    }

    fun stop(context: Context, kind: String, doneTitle: String?, doneText: String?) {
      val remaining = synchronized(lock) {
        work.remove(kind)
        work.size
      }
      NotificationManagerCompat.from(context).cancel(notificationId(kind))
      if (doneTitle != null) postDone(context, kind, doneTitle, doneText ?: "")
      val service = running ?: return
      if (remaining == 0) service.shutDown() else service.refresh()
    }

    fun dismissFinished(context: Context) {
      val manager = NotificationManagerCompat.from(context)
      manager.cancel(doneNotificationId("download"))
      manager.cancel(doneNotificationId("generation"))
    }

    private fun ensureChannels(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      // LOW: no sound or pop-up, and still allowed to be promoted to a Live Update (MIN isn't).
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ONGOING, "Downloads and replies", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shows model downloads and replies while the app is in the background."
          setShowBadge(false)
        }
      )
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_DONE, "Finished in the background", NotificationManager.IMPORTANCE_DEFAULT).apply {
          description = "Tells you when a download or a reply finished while you were away."
        }
      )
    }

    private fun openAppIntent(context: Context): PendingIntent? {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      // Brings the existing task forward instead of starting a second copy of the app.
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
      return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun actionIntent(context: Context, action: String): PendingIntent {
      val intent = Intent(context, NotificationActionReceiver::class.java).setAction(NotificationActionReceiver.ACTION_PREFIX + action)
      return PendingIntent.getBroadcast(context, action.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun build(context: Context, w: Work): Notification {
      val isDownload = w.kind == "download"
      val builder = NotificationCompat.Builder(context, CHANNEL_ONGOING)
        .setSmallIcon(if (isDownload) R.drawable.background_work_download else R.drawable.background_work_reply)
        .setContentTitle(w.title)
        .setContentText(w.text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setShowWhen(false)
        .setCategory(if (isDownload) NotificationCompat.CATEGORY_PROGRESS else NotificationCompat.CATEGORY_STATUS)
        .setContentIntent(openAppIntent(context))
        // Android 16: ask to be shown as a Live Update. Older versions ignore it.
        .setRequestPromotedOngoing(true)
        // A download is long, so show it right away. A reply's notification is deferred
        // (Android shows it after ~10 s), so short replies in the app never flash one up.
        .setForegroundServiceBehavior(
          if (isDownload) NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE else NotificationCompat.FOREGROUND_SERVICE_DEFERRED
        )

      val progress = w.progress
      if (progress != null) {
        if (Build.VERSION.SDK_INT >= 36) {
          builder.setStyle(
            NotificationCompat.ProgressStyle()
              .addProgressSegment(NotificationCompat.ProgressStyle.Segment(100))
              .setProgress(progress)
          )
        } else {
          builder.setProgress(100, progress, false)
        }
        builder.setShortCriticalText("$progress%")
      } else {
        builder.setStyle(NotificationCompat.BigTextStyle().bigText(w.text))
      }
      // Action buttons would make Android show the reply notification immediately, so only
      // downloads get one; tapping a reply notification opens the app, where it can be stopped.
      if (isDownload) builder.addAction(0, "Cancel", actionIntent(context, "cancel-download"))
      return builder.build()
    }

    private fun postDone(context: Context, kind: String, title: String, text: String) {
      val notification = NotificationCompat.Builder(context, CHANNEL_DONE)
        .setSmallIcon(if (kind == "download") R.drawable.background_work_download else R.drawable.background_work_reply)
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setAutoCancel(true)
        .setContentIntent(openAppIntent(context))
        .build()
      notify(context, doneNotificationId(kind), notification)
    }

    @SuppressLint("MissingPermission") // checked in canNotify()
    private fun notify(context: Context, id: Int, notification: Notification) {
      if (!canNotify(context)) return
      try {
        NotificationManagerCompat.from(context).notify(id, notification)
      } catch (e: Exception) {
        Log.w(TAG, "Could not post notification", e)
      }
    }

    private fun canNotify(context: Context) =
      Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
  }

  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    running = this
    starting = false
    if (!refresh()) {
      // Nothing to do (the work already ended, or the process was restarted). startForeground
      // must still be called after startForegroundService, or Android kills the app.
      enterForeground(placeholderNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      shutDown()
    }
    // Not sticky: after a crash the JS side that did the work is gone too.
    return START_NOT_STICKY
  }

  /** Re-post every notification and make the first one the foreground one. False if there's no work. */
  fun refresh(): Boolean {
    val active = synchronized(lock) { work.values.map { it.copy() } }
    if (active.isEmpty()) return false
    val primary = active.first()
    val types = active.fold(0) { acc, w -> acc or serviceType(w.kind) }
    if (!enterForeground(build(this, primary), types, notificationId(primary.kind))) return false
    active.drop(1).forEach { notify(this, notificationId(it.kind), build(this, it)) }
    acquireWakeLock()
    return true
  }

  private fun serviceType(kind: String): Int =
    if (kind == "generation" && Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
    else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC

  private fun enterForeground(notification: Notification, types: Int, id: Int = 4100): Boolean =
    try {
      ServiceCompat.startForeground(this, id, notification, types)
      true
    } catch (e: Exception) {
      // E.g. ForegroundServiceStartNotAllowedException if Android decided the app was in the background.
      Log.w(TAG, "Could not enter the foreground", e)
      false
    }

  private fun placeholderNotification(): Notification =
    NotificationCompat.Builder(this, CHANNEL_ONGOING)
      .setSmallIcon(R.drawable.background_work_download)
      .setContentTitle("Finishing up")
      .setSilent(true)
      .build()

  @SuppressLint("WakelockTimeout") // it has a timeout; lint can't see it through the constant
  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val power = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Odysseus:BackgroundWork").apply {
      setReferenceCounted(false)
      acquire(WAKE_LOCK_TIMEOUT_MS)
    }
  }

  fun shutDown() {
    // Detach first: work started from now on brings up a fresh service instead of this dying one.
    if (running === this) running = null
    starting = false
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  // Android 15 caps data-sync foreground services at 6 hours a day.
  override fun onTimeout(startId: Int, fgsType: Int) {
    synchronized(lock) { work.clear() }
    BackgroundWorkModule.emitAction("timeout")
    shutDown()
  }

  override fun onDestroy() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    if (running === this) running = null
    starting = false
    super.onDestroy()
  }
}
