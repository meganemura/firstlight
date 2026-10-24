# frozen_string_literal: true

# The RSpec recorder. firstlight passes it to every rspec a check starts,
# through SPEC_OPTS, and it listens to the reporter beside the formatters
# the project chose, so the output does not change. It records nothing
# while FIRSTLIGHT_TESTS is unset.

require_relative "firstlight_tests"

module FirstlightRspec
  class Listener
    def example_finished(notification)
      example = notification.example
      result = example.execution_result
      status = { passed: "passed", failed: "failed", pending: "skipped" }.fetch(result.status, "skipped")
      FirstlightTests.write(
        file: example.metadata[:file_path],
        line: example.metadata[:line_number],
        name: example.full_description,
        status: status,
        seconds: result.run_time,
        message: status == "failed" ? FirstlightTests.headline(result.exception) : nil,
        # An example id, like ./spec/a_spec.rb[1:2], names one example even
        # when a loop defines several on the same line.
        rerun: FirstlightTests.bundled("rspec #{FirstlightTests.quote(example.id)}")
      )
    end
  end
end

if FirstlightTests.out
  RSpec.configure do |config|
    config.reporter.register_listener(FirstlightRspec::Listener.new, :example_finished)
  end
end
