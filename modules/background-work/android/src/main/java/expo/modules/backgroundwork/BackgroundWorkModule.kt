package expo.modules.backgroundwork

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS bridge for BackgroundWorkService. See modules/background-work/index.ts for the JS API. */
class BackgroundWorkModule : Module() {
  companion object {
    @Volatile private var current: BackgroundWorkModule? = null

    /** Send a notification action to JS. False when no JS runtime is listening. */
    fun emitAction(action: String): Boolean {
      val module = current ?: return false
      module.sendEvent("onAction", mapOf("action" to action))
      return true
    }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("BackgroundWork")

    Events("onAction")

    OnCreate { current = this@BackgroundWorkModule }

    OnDestroy { if (current === this@BackgroundWorkModule) current = null }

    Function("start") { kind: String, title: String, text: String, progress: Int? ->
      BackgroundWorkService.start(context, kind, title, text, progress)
    }

    Function("update") { kind: String, title: String, text: String, progress: Int? ->
      BackgroundWorkService.update(context, kind, title, text, progress)
    }

    Function("stop") { kind: String, doneTitle: String?, doneText: String? ->
      BackgroundWorkService.stop(context, kind, doneTitle, doneText)
    }

    Function("dismissFinished") {
      BackgroundWorkService.dismissFinished(context)
    }
  }
}
