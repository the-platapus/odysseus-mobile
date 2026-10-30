package expo.modules.backgroundwork

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Handles notification buttons by passing them to JS, which owns the work. */
class NotificationActionReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_PREFIX = "expo.modules.backgroundwork.action."
  }

  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action?.removePrefix(ACTION_PREFIX) ?: return
    if (!BackgroundWorkModule.emitAction(action) && action == "cancel-download") {
      // JS is gone, so nothing is downloading anymore: just clear the notification.
      BackgroundWorkService.stop(context, "download", null, null)
    }
  }
}
